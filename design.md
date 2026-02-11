Vercel/Node/linebotモジュール　のスタックで構築

```js
    npm init -y

    npm install @line/bot-sdk
```
linebotのnodeモジュール
https://www.npmjs.com/package/@line/bot-sdk

以下がnodeとline-bot sdkのチュートリアル
https://qiita.com/GorillaSwe/items/fb261d07643e678bc6ff

=まずは下にline-botの概要を軽くまとめる=




#公式ラインの設定
LINE Developersにアカウント作成・ログイン
プロバイダー作成
チャンネルを作成
アクセストークン・チャンネルシークレットを取得

type moduleをpackage.jsonに追加した


package.json の "type": "module" により Node が ESM として扱う一方、ts-node-dev が CommonJS の require() で読み込むため競合しています。ESM 対応の tsx に切り替えます。
上を調べる


npm run build でdistフォルダを吐き出してからデプロイする。

webhook urlとvercel.jsonについて調べる。

ここまでの行程は以下のurlで解決。
https://zenn.dev/illionillion/articles/github-zenn-linkage-20240102

