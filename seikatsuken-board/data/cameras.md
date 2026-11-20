# ライブカメラ一覧（生活圏防災ライブボード）

Space版・GitHub Pages版で共有する定点カメラのカタログです。このファイルが正本で、`tools/build_cameras.py` がこの表から `cameras.json` を生成します。

- 画像は表示のみに使い、保存しません。出典（事務所名・カメラ名）を必ず併記します。
- 座標は地図表示用の概略です（設置地点の正確な座標ではありません）。
- 取得間隔は各カメラの更新間隔以上に間引くこと（ボードの更新タイミングでのみ取得）。

| id | カメラ名 | 場所 | 緯度 | 経度 | 画像URL | 出典 | 更新間隔(分) |
|---|---|---|---|---|---|---|---|
| sakunami | 作並除雪ステーション（国道48号） | 仙台 | 38.315 | 140.630 | https://www2.thr.mlit.go.jp/sendai/html/image/DR-74127-l.jpg | 国土交通省 仙台河川国道事務所 | 15 |
| sekiyama | 関山峠（国道48号） | 仙台 | 38.297 | 140.548 | https://www2.thr.mlit.go.jp/sendai/html/image/DR-74131-l.jpg | 国土交通省 仙台河川国道事務所 | 15 |
| hirosebashi | 広瀬橋水位観測所（広瀬川） | 仙台 | 38.248 | 140.855 | https://www2.thr.mlit.go.jp/sendai/html/image/KS-74121-l.jpg | 国土交通省 仙台河川国道事務所 | 15 |
| matsushima-kaigan | 松島海岸（国道45号） | 松島 | 38.368 | 141.062 | https://www2.thr.mlit.go.jp/sendai/html/image/DR-74102-l.jpg | 国土交通省 仙台河川国道事務所 | 15 |
| yamagata-ohashi | 山形大橋（国道13号） | 山形 | 38.244 | 140.343 | https://www2.thr.mlit.go.jp/yamagata/ycam/data/24379-1.jpg | 国土交通省 山形河川国道事務所 | 30 |
| higashine-ic | 東根IC（東北中央道） | 東根 | 38.420 | 140.385 | https://www2.thr.mlit.go.jp/yamagata/ycam/data/22147-1.jpg | 国土交通省 山形河川国道事務所 | 30 |
| yonezawa-ski | 米沢スキー場・気象（国道13号） | 米沢 | 37.835 | 140.155 | https://www2.thr.mlit.go.jp/yamagata/ycam/data/05018-1.jpg | 国土交通省 山形河川国道事務所 | 30 |
| kariyasu | 刈安（国道13号） | 米沢 | 37.862 | 140.180 | https://www2.thr.mlit.go.jp/yamagata/ycam/data/05016-1.jpg | 国土交通省 山形河川国道事務所 | 30 |

## 備考

- 仙台河川国道事務所の画像は 640×360、15分更新。山形河川国道事務所の画像は 640×480、30分更新（いずれも2026-11-20の調査で実測確認）。
- 利用条件は政府標準利用規約の運用が原則（出典明記で利用可）。川の防災情報（river.go.jp）経由の定期収集は規約上避けること（定常収集はデータ配信の利用が案内されているため）。このカタログは事務所サイト側の画像URLのみを使う。
- 福島（福島河川国道事務所・阿武隈川カメラ）は画像URLパターンの検証が済んでいないため、未収録。検証できたら追加する。
