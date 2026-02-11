/**
 * LINE Bot (KodaiBot) エントリポイント
 */

import {
    middleware,
    type MiddlewareConfig,
    type WebhookEvent,
    type TextMessage,
    type MessageAPIResponseBase,
    messagingApi,
  } from "@line/bot-sdk";
  import type { Application, Request, Response } from "express";
  import express from "express";
  import { load } from "ts-dotenv";

  // 環境変数 (.env) を読み込み
  const env = load({
    CHANNEL_ACCESS_TOKEN: String,
    CHANNEL_SECRET: String,
    PORT: Number,
  });

  const PORT = env.PORT || 3000;

  // LINE Bot 用の設定（署名検証・APIクライアント）
  const config = {
    channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
    channelSecret: env.CHANNEL_SECRET || "",
  };
  const middlewareConfig: MiddlewareConfig = config;
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
  });

  const app: Application = express();

  // ヘルスチェック用（Vercel や LINE Webhook 検証用）
  app.get("/", async (_: Request, res: Response): Promise<Response> => {
    return res.status(200).send({
      message: "success",
    });
  });
  
  /**
   * テキストメッセージイベントを処理し、ランダムな変換結果で返信する
   */
  const textEventHandler = async (
    event: WebhookEvent
  ): Promise<MessageAPIResponseBase | undefined> => {
    // テキストメッセージ以外は無視
    if (event.type !== "message" || event.message.type !== "text") {
      return undefined;
    }

    const { replyToken } = event;
    const text = (event.message as TextMessage).text;

    console.log(text);
  
    const response: TextMessage = {
      type: "text",
      text: text,
    };
    // 変換したテキストで返信
    await client.replyMessage({
      replyToken: replyToken,
      messages: [response],
    });
  };

  // LINE からの Webhook 受信エンドポイント（POST /webhook）
  app.post(
    "/webhook",
    middleware(middlewareConfig), // 署名検証
    async (req: Request, res: Response): Promise<void> => {
      const events: WebhookEvent[] = req.body.events ?? [];
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

  // サーバー起動（Vercel では未使用、ローカル用）
  app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}/`);
  });