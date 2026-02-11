/**
 * LINE Bot (KodaiBot) エントリポイント
 * タスク管理は ALLOWED_LINE_USER_ID で指定したユーザー（自分）にのみ反応する
 */
import { middleware, messagingApi, } from "@line/bot-sdk";
import express from "express";
import { load } from "ts-dotenv";
import { Redis } from "@upstash/redis";
const env = process.env.VERCEL === "1"
    ? process.env
    : (() => {
        try {
            return load({}, ".env");
        }
        catch {
            return process.env;
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
const middlewareConfig = config;
const client = new messagingApi.MessagingApiClient({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
});
const app = express();
// POST の JSON body を解析（LINE Webhook に必須。無いと req.body が undefined でクラッシュする）
app.use(express.json());
const KEY_PREFIX = "kodaibot";
// Upstash 用 (UPSTASH_*) または Vercel KV 用 (KV_REST_API_*) のどちらかがあれば Redis を使用
const redis = (() => {
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
const conversationState = new Map();
const taskListByUser = new Map();
// 1:1 は source.type === "user"。グループ/ルームは type が "group"/"room" だが message イベントでは userId が入る
function getUserId(event) {
    const src = event.source;
    return src?.userId ?? null;
}
function isAllowedUser(userId) {
    return !!ALLOWED_LINE_USER_ID && userId === ALLOWED_LINE_USER_ID;
}
async function getState(userId) {
    if (redis) {
        const raw = await redis.get(`${KEY_PREFIX}:state:${userId}`);
        if (raw && typeof raw === "string") {
            try {
                return JSON.parse(raw);
            }
            catch {
                return { type: "idle" };
            }
        }
        return { type: "idle" };
    }
    return conversationState.get(userId) ?? { type: "idle" };
}
async function setState(userId, state) {
    if (redis) {
        await redis.set(`${KEY_PREFIX}:state:${userId}`, JSON.stringify(state));
        return;
    }
    conversationState.set(userId, state);
}
async function getTasks(userId) {
    if (redis) {
        const raw = await redis.get(`${KEY_PREFIX}:tasks:${userId}`);
        if (Array.isArray(raw))
            return raw;
        if (typeof raw === "string") {
            try {
                return JSON.parse(raw);
            }
            catch {
                return [];
            }
        }
        return [];
    }
    return taskListByUser.get(userId) ?? [];
}
async function addTask(userId, task) {
    const list = await getTasks(userId);
    list.push(task);
    const sorted = [...list].sort((a, b) => a.priority - b.priority);
    if (redis) {
        await redis.set(`${KEY_PREFIX}:tasks:${userId}`, JSON.stringify(sorted));
        return;
    }
    taskListByUser.set(userId, sorted);
}
async function removeTaskByIndex(userId, oneBasedIndex) {
    const list = await getTasks(userId);
    const i = oneBasedIndex - 1;
    if (i < 0 || i >= list.length)
        return false;
    list.splice(i, 1);
    if (redis) {
        await redis.set(`${KEY_PREFIX}:tasks:${userId}`, JSON.stringify(list));
        return true;
    }
    taskListByUser.set(userId, [...list]);
    return true;
}
function formatTaskList(tasks) {
    if (tasks.length === 0)
        return "（タスクはありません）";
    return tasks
        .map((t, i) => `${i + 1}. ${t.name}（優先${t.priority}・${t.deadline}まで）`)
        .join("\n");
}
// ヘルスチェック用（Vercel や LINE Webhook 検証用）
app.get("/", async (_, res) => {
    return res.status(200).send({
        message: "success",
    });
});
/**
 * テキストメッセージを処理。許可ユーザーのみタスク管理に反応し、それ以外は何も返さない
 */
const textEventHandler = async (event) => {
    if (event.type !== "message" || event.message.type !== "text") {
        return undefined;
    }
    const userId = getUserId(event);
    const { replyToken } = event;
    const text = event.message.text.trim();
    // 「マイID」または「userid」で自分の LINE ユーザーIDを返す（.env の ALLOWED_LINE_USER_ID にコピーして使う）
    if (text === "マイID" || text.toLowerCase() === "userid") {
        const msg = userId
            ? `あなたのLINEユーザーID:\n${userId}`
            : "userId を取得できませんでした。Bot と1:1のトークで「マイID」と送信してみてください。";
        await client.replyMessage({
            replyToken,
            messages: [{ type: "text", text: msg }],
        });
        return undefined;
    }
    if (!isAllowedUser(userId)) {
        // 自分以外には反応しない（返信なし）
        return undefined;
    }
    const uid = userId;
    const state = await getState(uid);
    const tasks = await getTasks(uid);
    const reply = async (msg) => {
        await client.replyMessage({
            replyToken,
            messages: [{ type: "text", text: msg }],
        });
    };
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
            await reply("いつまでに終わらせたい？");
            return undefined;
        }
        if (state.step === "deadline") {
            const task = {
                id: `task-${Date.now()}`,
                name: state.taskName ?? "未定",
                priority: state.priority ?? 1,
                deadline: text,
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
    // その他のメッセージはエコー（従来どおり）
    await reply(text);
    return undefined;
};
// LINE からの Webhook 受信エンドポイント（POST /webhook）
app.post("/webhook", middleware(middlewareConfig), // 署名検証
async (req, res) => {
    const events = (req.body && req.body.events) ?? [];
    let hasError = false;
    await Promise.all(events.map(async (event) => {
        try {
            await textEventHandler(event);
        }
        catch (err) {
            hasError = true;
            console.error(err instanceof Error ? err.message : err);
        }
    }));
    if (hasError) {
        res.status(500).send("Internal Server Error");
    }
    else {
        res.status(200).send("OK");
    }
});
// 未処理エラーでクラッシュしないように（Vercel 500 防止）
app.use((err, _req, res, _next) => {
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
//# sourceMappingURL=index.js.map