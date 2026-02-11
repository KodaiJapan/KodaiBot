/**
 * LINE Bot (KodaiBot) エントリポイント
 * タスク管理は ALLOWED_LINE_USER_ID で指定したユーザー（自分）にのみ反応する
 */

import {
    middleware,
    type MiddlewareConfig,
    type WebhookEvent,
    type TextMessage,
    type MessageAPIResponseBase,
    messagingApi,
  } from "@line/bot-sdk";
  import type { Application, NextFunction, Request, Response } from "express";
  import express from "express";
  import { load } from "ts-dotenv";
  import { Redis } from "@upstash/redis";

  // 環境変数（Vercel では process.env のみ。ローカルでは .env を load）
  type EnvRecord = Record<string, string | undefined>;
  const env: EnvRecord =
    process.env.VERCEL === "1"
      ? (process.env as EnvRecord)
      : (() => {
          try {
            return load({}, ".env") as EnvRecord;
          } catch {
            return process.env as EnvRecord;
          }
        })();
  const CHANNEL_ACCESS_TOKEN = env.CHANNEL_ACCESS_TOKEN ?? "";
  const CHANNEL_SECRET = env.CHANNEL_SECRET ?? "";
  const PORT = Number(env.PORT) || 3000;
  const ALLOWED_LINE_USER_ID = env.ALLOWED_LINE_USER_ID ?? "";

  // LINE Bot 用の設定（署名検証・APIクライアント）
  const config = {
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
  };
  const middlewareConfig: MiddlewareConfig = config;
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
  });

  const app: Application = express();

  // ※ express.json() を /webhook より前に使うと、LINE の署名検証に必要な「生 body」が失われて検証失敗し、何も返らなくなる。
  // LINE の middleware が body をパースするので、/webhook では追加の body パースは不要。

  // --- タスク管理用の型とストア（Redis またはインメモリ） ---
  type Task = {
    id: string;
    name: string;
    priority: number;
    deadline: string;
    remindersSent?: string[]; // 送信済みリマインドのラベル（"24h", "1h", "30m" など）
  };
  type TaskAddStep = "task_name" | "priority" | "deadline";
  type TaskCompleteStep = "asking_index";
  type ConversationState =
    | { type: "idle" }
    | { type: "task_add"; step: TaskAddStep; taskName?: string; priority?: number }
    | { type: "task_complete"; step: TaskCompleteStep }
    | { type: "task_delete"; step: TaskCompleteStep };

  const KEY_PREFIX = "kodaibot";
  // Upstash 用 (UPSTASH_*) または Vercel KV 用 (KV_REST_API_*) のどちらかがあれば Redis を使用
  const redis: Redis | null = (() => {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return Redis.fromEnv();
    }
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      return new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
    }
    return null;
  })();

  const conversationState = new Map<string, ConversationState>();
  const taskListByUser = new Map<string, Task[]>();

  // 1:1 は source.type === "user"。グループ/ルームは type が "group"/"room" だが message イベントでは userId が入る
  function getUserId(event: WebhookEvent): string | null {
    const src = event.source as { userId?: string } | undefined;
    return src?.userId ?? null;
  }

  function isAllowedUser(userId: string | null): boolean {
    return !!ALLOWED_LINE_USER_ID && userId === ALLOWED_LINE_USER_ID;
  }

  async function getState(userId: string): Promise<ConversationState> {
    if (redis) {
      const raw = await redis.get(`${KEY_PREFIX}:state:${userId}`);
      if (raw != null) {
        if (typeof raw === "string") {
          try {
            return JSON.parse(raw) as ConversationState;
          } catch {
            return { type: "idle" };
          }
        }
        if (typeof raw === "object" && raw !== null && "type" in raw) {
          return raw as ConversationState;
        }
      }
      return { type: "idle" };
    }
    return conversationState.get(userId) ?? { type: "idle" };
  }
  async function setState(userId: string, state: ConversationState): Promise<void> {
    if (redis) {
      await redis.set(`${KEY_PREFIX}:state:${userId}`, JSON.stringify(state));
      return;
    }
    conversationState.set(userId, state);
  }
  async function getTasks(userId: string): Promise<Task[]> {
    if (redis) {
      const raw = await redis.get(`${KEY_PREFIX}:tasks:${userId}`);
      if (raw != null) {
        if (Array.isArray(raw)) return raw as Task[];
        if (typeof raw === "string") {
          try {
            return JSON.parse(raw) as Task[];
          } catch {
            return [];
          }
        }
      }
      return [];
    }
    return taskListByUser.get(userId) ?? [];
  }
  async function addTask(userId: string, task: Task): Promise<void> {
    const list = await getTasks(userId);
    list.push(task);
    const sorted = [...list].sort((a, b) => a.priority - b.priority);
    if (redis) {
      await redis.set(`${KEY_PREFIX}:tasks:${userId}`, JSON.stringify(sorted));
      return;
    }
    taskListByUser.set(userId, sorted);
  }
  async function removeTaskByIndex(userId: string, oneBasedIndex: number): Promise<boolean> {
    const list = await getTasks(userId);
    const i = oneBasedIndex - 1;
    if (i < 0 || i >= list.length) return false;
    list.splice(i, 1);
    if (redis) {
      await redis.set(`${KEY_PREFIX}:tasks:${userId}`, JSON.stringify(list));
      return true;
    }
    taskListByUser.set(userId, [...list]);
    return true;
  }

  function formatTaskList(tasks: Task[]): string {
    if (tasks.length === 0) return "（タスクはありません）";
    return tasks
      .map((t, i) => `${i + 1}. ${t.name}（優先${t.priority}・${t.deadline}まで）`)
      .join("\n");
  }

  /**
   * 「X月X日」「X月X日X時」「X月X日X時X分」を解釈し、統一した文字列で返す。
   * 解釈できない場合は null。
   */
  function parseDeadlineInput(input: string): string | null {
    const trimmed = input.trim();
    // X月X日 / X月X日X時 / X月X日X時X分（X は1〜2桁の数字）
    const m = trimmed.match(
      /^(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})時)?(?:\s*(\d{1,2})分)?$/
    );
    if (!m) return null;
    const month = parseInt(m[1]!, 10);
    const day = parseInt(m[2]!, 10);
    const hour = m[3] != null ? parseInt(m[3], 10) : null;
    const minute = m[4] != null ? parseInt(m[4], 10) : null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour != null && (hour < 0 || hour > 23)) return null;
    if (minute != null && (minute < 0 || minute > 59)) return null;
    let result = `${month}月${day}日`;
    if (hour != null) {
      result += ` ${hour}時`;
      if (minute != null) result += `${minute}分`;
    }
    return result;
  }

  /**
   * 期限文字列（12月25日 / 12月25日 14時30分）を Date に変換。
   * 年は現在年。過去日付なら翌年。
   */
  function parseDeadlineToDate(deadline: string): Date | null {
    const m = deadline.trim().match(
      /^(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})時)?(?:\s*(\d{1,2})分)?$/
    );
    if (!m) return null;
    const month = parseInt(m[1]!, 10) - 1; // 0-indexed
    const day = parseInt(m[2]!, 10);
    const hour = m[3] != null ? parseInt(m[3], 10) : 0;
    const minute = m[4] != null ? parseInt(m[4], 10) : 0;
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const now = new Date();
    let year = now.getFullYear();
    const d = new Date(year, month, day, hour, minute, 0, 0);
    if (d.getTime() < now.getTime()) year += 1;
    return new Date(year, month, day, hour, minute, 0, 0);
  }

  /** 優先度4用：期限の何分前に送るか（優先度1・2・3は別ロジック） */
  function getReminderSlots(priority: number): { label: string; minutesBefore: number }[] {
    switch (priority) {
      case 4:
      default:
        return [{ label: "1h", minutesBefore: 60 }];
    }
  }

  /** 現在時刻を JST で取得（日付 YYYY-MM-DD と 時 0-23） */
  function getJSTNow(now: number): { dateStr: string; hour: number } {
    const d = new Date(now + 9 * 60 * 60 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return { dateStr: `${y}-${m}-${day}`, hour: d.getUTCHours() };
  }

  async function updateTask(
    userId: string,
    taskId: string,
    updater: (t: Task) => Task
  ): Promise<boolean> {
    const list = await getTasks(userId);
    const i = list.findIndex((t) => t.id === taskId);
    if (i < 0) return false;
    list[i] = updater(list[i]!);
    const sorted = [...list].sort((a, b) => a.priority - b.priority);
    if (redis) {
      await redis.set(`${KEY_PREFIX}:tasks:${userId}`, JSON.stringify(sorted));
      return true;
    }
    taskListByUser.set(userId, sorted);
    return true;
  }

  // ヘルスチェック用（Vercel や LINE Webhook 検証用）
  app.get("/", async (_: Request, res: Response): Promise<Response> => {
    return res.status(200).send({
      message: "success",
    });
  });

  /**
   * リマインド送信（Vercel Cron から定期呼び出し。CRON_SECRET が設定されていれば ?secret=xxx で認証）
   */
  const CRON_SECRET = env.CRON_SECRET ?? "";
  app.get("/remind", async (req: Request, res: Response): Promise<void> => {
    if (CRON_SECRET && req.query.secret !== CRON_SECRET) {
      res.status(401).send("Unauthorized");
      return;
    }
    if (!ALLOWED_LINE_USER_ID || !CHANNEL_ACCESS_TOKEN) {
      res.status(200).send("OK");
      return;
    }
    if (!redis) {
      res.status(200).send("OK");
      return;
    }
    const userId = ALLOWED_LINE_USER_ID;
    const tasks = await getTasks(userId);
    const now = Date.now();
    const jst = getJSTNow(now);
    const windowMinutes = 12;

    for (const task of tasks) {
      const deadlineDate = parseDeadlineToDate(task.deadline);
      if (!deadlineDate) continue;
      const remainingMinutes = (deadlineDate.getTime() - now) / (60 * 1000);
      if (remainingMinutes < 0) continue;
      const remainingDays = remainingMinutes / (24 * 60);
      const sent = new Set(task.remindersSent ?? []);

      // 優先度1: 7日以上先なら1日1回9時、7日未満なら1日3回（8時・12時・18時）JST
      if (task.priority === 1) {
        let slotKey: string | null = null;
        let labelText = "";
        if (remainingDays >= 7) {
          if (jst.hour === 9) slotKey = `${jst.dateStr}-9`;
          labelText = "（毎朝9時のリマインド）";
        } else {
          if (jst.hour === 8) slotKey = `${jst.dateStr}-8`;
          else if (jst.hour === 12) slotKey = `${jst.dateStr}-12`;
          else if (jst.hour === 18) slotKey = `${jst.dateStr}-18`;
          labelText =
            jst.hour === 8
              ? "（朝8時のリマインド）"
              : jst.hour === 12
                ? "（昼12時のリマインド）"
                : "（夜6時のリマインド）";
        }
        if (slotKey != null && !sent.has(slotKey)) {
          const msg = `【リマインド】${task.name} は ${task.deadline} までです。${labelText}`;
          try {
            await client.pushMessage({
              to: userId,
              messages: [{ type: "text", text: msg }],
            });
            await updateTask(userId, task.id, (t) => ({
              ...t,
              remindersSent: [...(t.remindersSent ?? []), slotKey],
            }));
          } catch (err) {
            console.error("remind push failed:", err);
          }
        }
        continue;
      }

      // 優先度2: 7日以上先なら3の倍数の日の昼12時、7日未満なら1日2回（朝10時・夜10時）JST
      if (task.priority === 2) {
        let slotKey: string | null = null;
        let labelText = "";
        if (remainingDays >= 7) {
          const daysLeft = Math.floor(remainingDays);
          if (jst.hour === 12 && daysLeft >= 3 && daysLeft % 3 === 0) {
            slotKey = `${daysLeft}d-12`;
          }
          labelText = "（3の倍数の日のリマインド）";
        } else {
          if (jst.hour === 10) slotKey = `${jst.dateStr}-10`;
          else if (jst.hour === 22) slotKey = `${jst.dateStr}-22`;
          labelText =
            jst.hour === 10 ? "（朝10時のリマインド）" : "（夜10時のリマインド）";
        }
        if (slotKey != null && !sent.has(slotKey)) {
          const msg = `【リマインド】${task.name} は ${task.deadline} までです。${labelText}`;
          try {
            await client.pushMessage({
              to: userId,
              messages: [{ type: "text", text: msg }],
            });
            await updateTask(userId, task.id, (t) => ({
              ...t,
              remindersSent: [...(t.remindersSent ?? []), slotKey],
            }));
          } catch (err) {
            console.error("remind push failed:", err);
          }
        }
        continue;
      }

      // 優先度3: 7日以上先なら5の倍数の日の14時、7日未満なら1日1回夜5時 JST
      if (task.priority === 3) {
        let slotKey: string | null = null;
        let labelText = "";
        if (remainingDays >= 7) {
          const daysLeft = Math.floor(remainingDays);
          if (jst.hour === 14 && daysLeft >= 5 && daysLeft % 5 === 0) {
            slotKey = `${daysLeft}d-14`;
          }
          labelText = "（5の倍数の日のリマインド）";
        } else {
          if (jst.hour === 17) slotKey = `${jst.dateStr}-17`;
          labelText = "（夜5時のリマインド）";
        }
        if (slotKey != null && !sent.has(slotKey)) {
          const msg = `【リマインド】${task.name} は ${task.deadline} までです。${labelText}`;
          try {
            await client.pushMessage({
              to: userId,
              messages: [{ type: "text", text: msg }],
            });
            await updateTask(userId, task.id, (t) => ({
              ...t,
              remindersSent: [...(t.remindersSent ?? []), slotKey],
            }));
          } catch (err) {
            console.error("remind push failed:", err);
          }
        }
        continue;
      }

      // 優先度4: 期限の○分前リマインド（従来どおり）
      for (const slot of getReminderSlots(task.priority)) {
        if (sent.has(slot.label)) continue;
        if (
          remainingMinutes <= slot.minutesBefore &&
          remainingMinutes > slot.minutesBefore - windowMinutes
        ) {
          const labelText =
            slot.label === "24h"
              ? "あと24時間"
              : slot.label === "1h"
                ? "あと1時間"
                : "あと30分";
          const msg = `【リマインド】${task.name} は ${task.deadline} までです。（${labelText}）`;
          try {
            await client.pushMessage({
              to: userId,
              messages: [{ type: "text", text: msg }],
            });
            await updateTask(userId, task.id, (t) => ({
              ...t,
              remindersSent: [...(t.remindersSent ?? []), slot.label],
            }));
          } catch (err) {
            console.error("remind push failed:", err);
          }
          break;
        }
      }
    }
    res.status(200).send("OK");
  });

  /**
   * テキストメッセージを処理。許可ユーザーのみタスク管理に反応し、それ以外は何も返さない
   */
  const textEventHandler = async (
    event: WebhookEvent
  ): Promise<MessageAPIResponseBase | undefined> => {
    if (event.type !== "message" || event.message.type !== "text") {
      return undefined;
    }

    const userId = getUserId(event);
    const { replyToken } = event;
    const text = (event.message as TextMessage).text.trim();

    if (!isAllowedUser(userId)) {
      // 自分以外には反応しない（返信なし）
      return undefined;
    }

    const uid = userId as string;
    const state = await getState(uid);
    const tasks = await getTasks(uid);

    const reply = async (msg: string) => {
      await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: msg }],
      });
    };

    // フロー途中で止めるコマンド（タスク追加・タスク完了のどちらでも有効）
    const isCancelCommand =
      text === "キャンセル" || text === "やめる" || text === "中止" || text === "cancel";
    if (isCancelCommand && state.type !== "idle") {
      await setState(uid, { type: "idle" });
      const flowName =
        state.type === "task_add"
          ? "タスク追加"
          : state.type === "task_delete"
            ? "タスク削除"
            : "タスク完了";
      await reply(`${flowName}をキャンセルしました。`);
      return undefined;
    }

    // タスク追加フロー途中の応答
    if (state.type === "task_add") {
      if (state.step === "task_name") {
        await setState(uid, {
          type: "task_add",
          step: "priority",
          taskName: text,
        });
        await reply("優先順位は？1-4");
        return undefined;
      }
      if (state.step === "priority") {
        const p = parseInt(text, 10);
        if (p < 1 || p > 4) {
          await reply("1〜4の数字で入力してください。優先順位は？1-4");
          return undefined;
        }
        await setState(uid, {
          type: "task_add",
          step: "deadline",
          taskName: state.taskName ?? "未定",
          priority: p,
        });
        await reply("いつまでに終わらせたい？（例: 12月25日 または 12月25日14時30分）");
        return undefined;
      }
      if (state.step === "deadline") {
        const deadlineStr = parseDeadlineInput(text);
        if (deadlineStr === null) {
          await reply(
            "日付がわかりません。例: 12月25日 または 12月25日14時30分 のように入力してください。"
          );
          return undefined;
        }
        const task: Task = {
          id: `task-${Date.now()}`,
          name: state.taskName ?? "未定",
          priority: state.priority ?? 1,
          deadline: deadlineStr,
          remindersSent: [],
        };
        await addTask(uid, task);
        await setState(uid, { type: "idle" });
        await reply("了解です。優先順位に合わせてリマインドしていきます。");
        return undefined;
      }
    }

    // タスク完了フロー：番号を聞いている途中
    if (state.type === "task_complete") {
      const num = parseInt(text, 10);
      if (Number.isNaN(num) || num < 1 || num > tasks.length) {
        await reply("番号が不正です。何番のタスクが終わりましたか？\n" + formatTaskList(tasks));
        return undefined;
      }
      await removeTaskByIndex(uid, num);
      await setState(uid, { type: "idle" });
      await reply("タスクリストから削除しました。Great job!");
      return undefined;
    }

    // タスク削除フロー：番号を聞いている途中
    if (state.type === "task_delete") {
      const num = parseInt(text, 10);
      if (Number.isNaN(num) || num < 1 || num > tasks.length) {
        await reply("番号が不正です。何番のタスクを削除しますか？\n" + formatTaskList(tasks));
        return undefined;
      }
      await removeTaskByIndex(uid, num);
      await setState(uid, { type: "idle" });
      await reply("削除しました。");
      return undefined;
    }

    // コマンド判定（idle 時のみ）
    if (text === "タスク追加") {
      await setState(uid, { type: "task_add", step: "task_name" });
      await reply("タスク名は？");
      return undefined;
    }
    if (text === "タスク") {
      await reply("タスク一覧ですね。どうぞ\n" + formatTaskList(tasks));
      return undefined;
    }
    if (text === "タスク完了") {
      if (tasks.length === 0) {
        await reply("タスクはありません。");
        return undefined;
      }
      await setState(uid, { type: "task_complete", step: "asking_index" });
      await reply("何番のタスクが終わりましたか？\n" + formatTaskList(tasks));
      return undefined;
    }
    if (text === "タスク削除") {
      if (tasks.length === 0) {
        await reply("タスクはありません。");
        return undefined;
      }
      await setState(uid, { type: "task_delete", step: "asking_index" });
      await reply("何番のタスクを削除しますか？\n" + formatTaskList(tasks));
      return undefined;
    }

    // その他のメッセージはエコー（従来どおり）
    await reply(text);
    return undefined;
  };

  // LINE からの Webhook 受信エンドポイント（POST /webhook）
  app.post(
    "/webhook",
    middleware(middlewareConfig), // 署名検証
    async (req: Request, res: Response): Promise<void> => {
      const events: WebhookEvent[] = (req.body && req.body.events) ?? [];
      let hasError = false;
      await Promise.all(
        events.map(async (event: WebhookEvent) => {
          try {
            await textEventHandler(event);
          } catch (err: unknown) {
            hasError = true;
            console.error(err instanceof Error ? err.message : err);
          }
        })
      );
      if (hasError) {
        res.status(500).send("Internal Server Error");
      } else {
        res.status(200).send("OK");
      }
    }
  );

  // 未処理エラーでクラッシュしないように（Vercel 500 防止）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).send("Internal Server Error");
  });

  // サーバー起動はローカルのみ（Vercel では export された app がハンドラとして使われる）
  if (process.env.VERCEL !== "1") {
    app.listen(PORT, () => {
      console.log(`http://localhost:${PORT}/`);
    });
  }

  export default app;