# Redis（Upstash）の追加方法

タスク管理の会話状態・タスク一覧を Vercel 本番で永続化するには **Upstash Redis** を追加します。  
環境変数が未設定のときはインメモリで動くため、ローカル開発では Redis なしでも問題ありません。

---

## 方法1: Vercel の Marketplace から追加（推奨）

1. [Vercel Dashboard](https://vercel.com/dashboard) でプロジェクトを開く
2. **Storage** タブ → **Create Database**
3. **Upstash Redis** を選んで **Continue**
4. 名前を付けて **Create**
5. 作成した Redis を開き、**Connect Project** でこの KodaiBot プロジェクトを選択
6. 環境変数（`UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN`）が自動でプロジェクトに追加されます
7. **Redeploy** で再デプロイすれば、タスク・会話状態が Redis に保存されます

---

## 方法2: Upstash のサイトで作成して手動で環境変数設定

1. [Upstash Console](https://console.upstash.com/) にログイン（GitHub 等で可）
2. **Create Database** → リージョンなどを選んで作成
3. 作成した DB の **REST API** 欄で次をコピー:
   - **UPSTASH_REDIS_REST_URL**
   - **UPSTASH_REDIS_REST_TOKEN**
4. **Vercel** の場合:
   - プロジェクト → **Settings** → **Environment Variables**
   - 上記2つを追加（Production / Preview / Development は必要に応じて）
5. **ローカル**の場合:
   - プロジェクトの `.env` に同じ2行を追加
6. 再デプロイ（Vercel）またはサーバー再起動（ローカル）

---

## 対応している環境変数

次の**どちらか**が設定されていれば Redis を使います。

| 種類 | 必要な環境変数 |
|------|----------------|
| Upstash | `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` |
| Vercel KV（Storage） | `KV_REST_API_URL` と `KV_REST_API_TOKEN` |

※ `KV_REST_API_READ_ONLY_TOKEN` は読み取り専用のため使いません。`KV_REST_API_TOKEN` を設定してください。

---

## 動作の切り替え

- **上記の環境変数がそろっている**  
  → 会話状態・タスク一覧を Redis に保存（Vercel 本番向け）
- **環境変数なし**  
  → インメモリで保存（ローカル開発や Redis 未設定時。Vercel では再デプロイごとにリセットされる）
