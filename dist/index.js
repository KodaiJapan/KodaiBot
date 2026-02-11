import { middleware, messagingApi, } from "@line/bot-sdk";
import express from "express";
import { load } from "ts-dotenv";
const env = load({
    CHANNEL_ACCESS_TOKEN: String,
    CHANNEL_SECRET: String,
    PORT: Number,
});
const PORT = env.PORT || 3000;
const config = {
    channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
    channelSecret: env.CHANNEL_SECRET || "",
};
const middlewareConfig = config;
const client = new messagingApi.MessagingApiClient({
    channelAccessToken: env.CHANNEL_ACCESS_TOKEN || "",
});
const app = express();
app.get("/", async (_, res) => {
    return res.status(200).send({
        message: "success",
    });
});
const textEventHandler = async (event) => {
    if (event.type !== "message" || event.message.type !== "text") {
        return undefined;
    }
    const { replyToken } = event;
    const text = event.message.text;
    const resText = (() => {
        switch (Math.floor(Math.random() * 3)) {
            case 0:
                return text.split("").reverse().join("");
            case 1:
                return text.split("").join(" ");
            default:
                return text.split("").reverse().join(" ");
        }
    })();
    console.log(resText);
    const response = {
        type: "text",
        text: resText,
    };
    await client.replyMessage({
        replyToken: replyToken,
        messages: [response],
    });
};
app.post("/webhook", middleware(middlewareConfig), async (req, res) => {
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
app.listen(PORT, () => {
    console.log(`http://localhost:${PORT}/`);
});
//# sourceMappingURL=index.js.map