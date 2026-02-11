/**
 * LINE Bot (KodaiBot) エントリポイント
 */
import { middleware, messagingApi, } from "@line/bot-sdk";
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
const middlewareConfig = config;
const client = new messagingApi.MessagingApiClient({
    channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
});
const app = express();
// ヘルスチェック用（Vercel や LINE Webhook 検証用）
app.get("/", async (_, res) => {
    return res.status(200).send({
        message: "success",
    });
});
/**
 * テキストメッセージイベントを処理し、ランダムな変換結果で返信する
 */
const textEventHandler = async (event) => {
    // テキストメッセージ以外は無視
    if (event.type !== "message" || event.message.type !== "text") {
        return undefined;
    }
    const { replyToken } = event;
    const text = event.message.text;
    console.log(text);
    const response = {
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
app.post("/webhook", middleware(middlewareConfig), // 署名検証
async (req, res) => {
    const events = req.body.events ?? [];
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
// サーバー起動（Vercel では未使用、ローカル用）
app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}/`);
});
//# sourceMappingURL=index.js.map