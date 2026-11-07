# 4方式のソースコード見比べ ― CubeBoy

同じゲーム「CubeBoy」を4方式で実装したソース同士の見比べ資料。仕組み全体の違いは [four-ways-mechanism.md](four-ways-mechanism.md) を参照。ここではコードそのものを並べる。

## 使ったソース

| 方式 | ファイル | 行数 |
|---|---|---|
| 本家 Pyxel（Python） | `~/workspace/html-player/games/cube-boy-pyx/index.html` に埋め込まれた `Cubeboy.pyxapp` 内の `Cubeboy/Cubeboy.py`（抽出コピー: `~/workspace/pyxel-bench/src-python/cubeboy/Cubeboy.py`） | 780 行 |
| pyxel-rust（Rust） | `~/workspace/pyxel-bench/src/pyxel-rust/examples/cubeboy.rs`（`docs/examples/cubeboy.rs` と同一内容） | 511 行 |
| 素の JavaScript | `~/workspace/pyxel-bench/site/html-player/games/cube-boy/index.html`（HTML 1 枚にゲームのスクリプトが入る） | 464 行（HTML 全体） |
| rustgames（Rust） | `~/workspace/rustgames/wasm_app/src/cubeboy.rs`（駆動と入力の受け渡しは同リポの `wasm_app/src/lib.rs`） | 973 行（このファイルのみ。基盤側は別） |

## 先に: 4本の系統

移植の系統は一本の鎖です（開発順と担当は著者による）。

- **Python 版**が原作です（タイトル・全状態・BGM・複数ルーム管理まで持つ完全版）。制作には Antigravity を使いました。
- **pyxel-rust 版**は Python 版の移植です。移植は Codex が実施しました（pyxel-rust エンジンを作ったときの移植）。定数名もクラス構成もほぼ 1 対 1 で対応しますが、簡略化された部分があります。
- **rustgames 版**は pyxel-rust 版の移植です。移植は Codex が実施しました。部屋生成は座標シードによる決定的な生成（FNV-1a ハッシュ＋mulberry32 乱数）になり、複数ルームも戻りました。音は `audio_event` という番号をページ側へ返す方式で、BGM はありません。
- **JavaScript 版**は rustgames 版の移植です。移植は、本人の記憶では Muse が実施しました。rustgames の部屋生成の規則と乱数列を引き継いでいます。効果音はプレイヤー共通部品の beep だけで、BGM はありません。

なお、コード上のコメントはこの順序と食い違います。rustgames 版の `cubeboy.rs` 冒頭には「html-player 版 CubeBoy（JS）の移植」とあり、乱数ユーティリティ（`rng.rs`）には「JS の 32bit 演算をそのまま移植する」と明記されています。JavaScript 版の冒頭には「Pyxel 版からの作り直し」とあります。コメントの文面はそうなっていますが、実際の開発順は著者によれば Python → pyxel-rust → rustgames → JavaScript です（コメント自体は当時のまま残してあります）。

プレイヤーの物理（コヨーテタイム 5、ジャンプバッファ 4、ダッシュ 5 倍速・6 フレーム、ジャンプ速度 −4.5、壁ジャンプ −4.2／±3.5 など）は、4方式とも同じ名前・同じ数値で実装されています。

---

## 1. 定数定義 ― 色の持ち方が途中で変わる

**Python**（`Cubeboy.py` 冒頭）

```python
# Constants
W = 128
H = 128
TILE_SIZE = 8
COLOR_BG = 0
COLOR_WALL = 1
COLOR_PLAYER_READY = 7
COLOR_PLAYER_SPENT = 14
COLOR_PARTICLE = 12
COLOR_ORB = 10
COLOR_SPIKE = 7
COLOR_CRYSTAL = 12
COLOR_MOUNTAIN_1 = 1
COLOR_MOUNTAIN_2 = 13
STATE_START = 0
STATE_PLAY = 1
STATE_BOSS = 2
STATE_GAMEOVER = 3
STATE_GAMECLEAR = 4
STATE_GAMEOVER_SEQ = 5
```

**pyxel-rust**（`cubeboy.rs` 冒頭）

```rust
use pyxel_rust::prelude::*;

const W: u32 = 128;
const H: u32 = 128;
const TILE_SIZE: u32 = 8;

// Colors
const COLOR_BG: u32 = 0;
const COLOR_WALL: u32 = 1;
const COLOR_PLAYER_READY: u32 = 7;
const COLOR_PLAYER_SPENT: u32 = 14;
const COLOR_PARTICLE: u32 = 12;
const COLOR_ORB: u32 = 10;
const COLOR_SPIKE: u32 = 7;

// Game states
const STATE_PLAY: u32 = 1;
const STATE_BOSS: u32 = 2;
const STATE_GAMECLEAR: u32 = 3;
```

**JavaScript**（`index.html` 22 行目〜）

```js
const W=128,H=128,TS=8;
const cv=document.getElementById("cv"),g=cv.getContext("2d");
// Pyxel default palette (subset)
const C_BG="#000000",C_WALL="#2B335F",C_WALLD="#5F574F",C_WHITE="#FFF1E8",
C_PINK="#FF77A8",C_CYAN="#29ADFF",C_GRAYC="#C2C3C7",C_YEL="#FFEC27",
C_RED="#FF004D",C_MTN1="#7E2553",C_MTN2="#5F574F",C_ROOM="#83769C";
```

**rustgames**（`cubeboy.rs` 14 行目〜）

```rust
pub const VW: f32 = 128.0;
pub const VH: f32 = 128.0;
const TS: f32 = 8.0;

// Pyxel パレット（部分）
const C_BG: Rgba = Rgba::hex(0x000000);
const C_WALL: Rgba = Rgba::hex(0x2B335F);
const C_WALLD: Rgba = Rgba::hex(0x5F574F);
const C_WHITE: Rgba = Rgba::hex(0xFFF1E8);
const C_PINK: Rgba = Rgba::hex(0xFF77A8);
const C_CYAN: Rgba = Rgba::hex(0x29ADFF);
```

**何が違うか**

- Python と pyxel-rust の色は「Pyxel パレットの番号」（0〜15）です。エンジンがパレットを持っていて、番号で指す書き方です。
- JavaScript と rustgames の色は、色の値そのもの（`"#2B335F"` や `Rgba::hex(0x2B335F)`）です。エンジンのパレットが無いので、ゲーム側が値で持ちます。両者の値が一致しているのは、JavaScript 版が rustgames 版の移植で、色の値を引き継いだからです。
- 状態（STATE_）は Python が 6 つ、pyxel-rust は 3 つ。JavaScript は文字列（`"title"` など、6 節）、rustgames は `enum Scene` の 5 つ（38 行目〜）で持ちます（6 節参照）。

---

## 2. データの持ち方 ― class／struct／ただのオブジェクト／全部入り struct

### Particle（粒子の1粒）

**Python**（`Cubeboy.py` 26 行目〜）

```python
class Particle:
    def __init__(self, x, y, dx, dy, col, life):
        self.x = x
        self.y = y
        self.dx = dx
        self.dy = dy
        self.col = col
        self.life = life

    def update(self):
        self.x += self.dx
        self.y += self.dy
        self.life -= 1

    def draw(self):
        pyxel.pset(self.x, self.y, self.col)
```

**pyxel-rust**（`cubeboy.rs` 26 行目〜）

```rust
#[derive(Clone, Copy)]
struct Particle {
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
    col: u32,
    life: i32,
}

impl Particle {
    fn new(x: f32, y: f32, dx: f32, dy: f32, col: u32, life: i32) -> Self {
        Particle { x, y, dx, dy, col, life }
    }

    fn update(&mut self) {
        self.x += self.dx;
        self.y += self.dy;
        self.life -= 1;
    }

    fn draw(&self) {
        pset(self.x, self.y, self.col as u8);
    }

    fn is_alive(&self) -> bool {
        self.life > 0
    }
}
```

**JavaScript** には Particle の定義がありません。生成箇所でオブジェクトリテラルをそのまま配列に入れます（`updPlayer` 内、137 行目〜のダッシュ処理。5 節参照）:

```js
    parts.push({x:p.x+3,y:p.y+3,dx:Math.random()*2-1,dy:Math.random()*2-1,col:C_CYAN,life:10});
```

更新と消去も、ループで回して `filter` で残すだけです（`index.html` 439〜440 行目）:

```js
  for(const p of parts){p.x+=p.dx;p.y+=p.dy;p.life--}
  parts=parts.filter(p=>p.life>0);
```

**rustgames**（`cubeboy.rs` 57 行目〜）

```rust
#[derive(Clone, Copy)]
struct Particle {
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
    col: Rgba,
    life: i32,
}
```

更新と消去はゲーム本体のメソッドです（791 行目〜）:

```rust
    fn update_particles(&mut self) {
        for p in self.parts.iter_mut() {
            p.x += p.dx;
            p.y += p.dy;
            p.life -= 1;
        }
        self.parts.retain(|p| p.life > 0);
    }
```

### Player（プレイヤー）のフィールド

**Python**（`Cubeboy.py` 44 行目〜、`Player.__init__`）

```python
    def __init__(self, x, y):
        self.x = float(x)
        self.y = float(y)
        self.vx = 0.0
        self.vy = 0.0
        self.width = 6
        self.height = 6
        
        # State
        self.is_on_ground = False
        self.is_on_wall = 0 # -1 left, 1 right, 0 none
        self.can_dash = True
        self.dash_time = 0
        self.dash_dir = (0.0, 0.0)
        
        # Feel
        self.coyote_timer = 0
        self.jump_buffer = 0
        
        # Visuals
        self.stretch_x = 1.0
        self.stretch_y = 1.0
        self.facing = 1 # 1 right, -1 left
        self.is_dead = False
```

**pyxel-rust**（`cubeboy.rs` 113 行目〜、`struct Player`。初期化は続く `fn new` で同じ順に値を入れる）

```rust
struct Player {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    width: f32,
    height: f32,
    is_on_ground: bool,
    is_on_wall: i32,
    can_dash: bool,
    dash_time: i32,
    dash_dir: (f32, f32),
    coyote_timer: i32,
    jump_buffer: i32,
    stretch_x: f32,
    stretch_y: f32,
    facing: i32,
    is_dead: bool,
}
```

**JavaScript**（`index.html` 103 行目〜、`mkPlayer`）

```js
function mkPlayer(x,y){
  return {x,y,vx:0,vy:0,w:6,h:6,onGround:false,onWall:0,canDash:true,
          dashTime:0,dashDir:[0,0],coyote:0,buf:0,sx:1,sy:1,facing:1,dead:false};
}
```

**rustgames**（`cubeboy.rs` 74 行目〜、`struct Player`）

```rust
struct Player {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    w: f32,
    h: f32,
    on_ground: bool,
    on_wall: i32,
    can_dash: bool,
    dash_time: i32,
    dash_dir: (f32, f32),
    coyote: i32,
    buf: i32,
    sx: f32,
    sy: f32,
    facing: i32,
    dead: bool,
}
```

**何が違うか**

- フィールドの顔ぶれは4方式とも同じです。ただし名前の系譜が分かれます。Python／pyxel-rust は `is_on_ground`、`coyote_timer`、`jump_buffer`、`width` という長い名前。JavaScript／rustgames は `onGround`／`on_ground`、`coyote`、`buf`、`w` と短い名前で、JavaScript 版が rustgames 版の命名を引き継いでいることが分かります。
- Python は `class`＋`__init__` で代入してフィールドを決める。Rust 2方式は `struct` でフィールドと型を先に宣言する。JavaScript は生成関数（`mkPlayer`）がオブジェクトリテラルを返すだけで、型もクラスもありません。
- 書き換えるメソッドには `&mut self`、読みだけなら `&self` と、借用の形が署名に現れるのは Rust 2方式共通です。Python と JavaScript はその区別を書きません。
- 粒子（Particle）の扱いが対照的です。Python と pyxel-rust はクラス／構造体として定義し、`draw` まで持ちます。JavaScript は定義すらなく、オブジェクトリテラルを配列に入れて、描画は描画側のループで `fillRect` します。rustgames は構造体として定義しますが、更新はゲーム本体の `update_particles` が担い、描画も `draw` 側に寄っています。
- ゲーム全体の状態の置き場所も分かれます。Python は `App` クラス、pyxel-rust は `Game` 構造体が持ちます。JavaScript はファイル直下のグローバル変数（`let state`、`let tm`、`let player` など）に散らします。rustgames は `CubeBoyGame` 構造体（`cubeboy.rs` 254 行目〜）に、プレイヤーや粒子だけでなく、レンダラー（`renderer: Renderer2d`）、描画バッファ（`draw: Draw2d`）、入力（`input: Input`）、固定ステップの蓄積（`acc: f64`）まで全部入っています。「ゲーム＋実行の道具立て」を1つの構造体に寄せた形です。

---

## 3. 入力の受け方 ― 4方式で全部違う

**Python**（`Cubeboy.py` 69 行目〜、`Player.get_input`）

```python
    def get_input(self):
        dx = 0
        if pyxel.btn(pyxel.KEY_LEFT) or pyxel.btn(pyxel.KEY_A) or pyxel.btn(pyxel.GAMEPAD1_BUTTON_DPAD_LEFT):
            dx -= 1
        if pyxel.btn(pyxel.KEY_RIGHT) or pyxel.btn(pyxel.KEY_D) or pyxel.btn(pyxel.GAMEPAD1_BUTTON_DPAD_RIGHT):
            dx += 1
        
        dy = 0
        if pyxel.btn(pyxel.KEY_UP) or pyxel.btn(pyxel.KEY_W) or pyxel.btn(pyxel.GAMEPAD1_BUTTON_DPAD_UP):
            dy -= 1
        if pyxel.btn(pyxel.KEY_DOWN) or pyxel.btn(pyxel.KEY_S) or pyxel.btn(pyxel.GAMEPAD1_BUTTON_DPAD_DOWN):
            dy += 1
        
        return dx, dy
```

**pyxel-rust**（`cubeboy.rs` 178 行目〜、`Player::get_input`）

```rust
    fn get_input(&self) -> (i32, i32) {
        let mut dx = 0i32;
        let mut dy = 0i32;

        if btn(KEY_LEFT) || btn(KEY_A) {
            dx -= 1;
        }
        if btn(KEY_RIGHT) || btn(KEY_D) {
            dx += 1;
        }
        if btn(KEY_UP) || btn(KEY_W) {
            dy -= 1;
        }
        if btn(KEY_DOWN) || btn(KEY_S) {
            dy += 1;
        }

        (dx, dy)
    }
```

**JavaScript**（`index.html` 131 行目〜、`updPlayer` の冒頭。入力取得の専用関数は無い）

```js
  const dxIn=(HP.right()?1:0)-(HP.left()?1:0);
  const dyIn=(HP.down()?1:0)-(HP.up()?1:0);
```

ジャンプとダッシュの判定は、同じ `updPlayer` の中で `cbAEdge`（Aボタンの押した瞬間）、`tapNowA`（タップ）、`HP.up()` の立ち上がりなどを見ます。これらのエッジは `step()`（445 行目〜）が毎ステップ先に計算して渡しています。

**rustgames**（`cubeboy.rs` 47 行目〜の `Input` 構造体と、511 行目〜 `update_player` の冒頭）

```rust
#[derive(Default, Clone, Copy)]
pub struct Input {
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub a: bool,
    pub b: bool,
}
```

```rust
        let dx_in: i32 = (self.input.right as i32) - (self.input.left as i32);
        let dy_in: i32 = (self.input.down as i32) - (self.input.up as i32);
```

この `input` に値を入れるのはページ側の JavaScript で、`lib.rs` の公開関数（515 行目〜）がビットマスクをほぐして書き込みます:

```rust
/// 入力マスク: 1=左 2=右 4=上 8=下 16=A(ジャンプ) 32=B(ダッシュ)
#[wasm_bindgen] pub fn set_input_cubeboy(mask: u32) {
    CUBEBOY.with(|s| {
        if let Some(g) = s.borrow_mut().as_mut() {
            g.input.left = mask & 1 != 0;
            g.input.right = mask & 2 != 0;
            g.input.up = mask & 4 != 0;
            g.input.down = mask & 8 != 0;
            g.input.a = mask & 16 != 0;
            g.input.b = mask & 32 != 0;
        }
    });
}
```

**何が違うか**

- 入力の出どころが4方式で全部違います。Python はエンジンの API（`pyxel.btn(...)`、キーボードとゲームパッドをエンジンがまとめる）。pyxel-rust はその互換 API（`btn(...)`、ただしゲームパッド分は落ちている）。JavaScript はプレイヤー共通部品 hp.js（`HP.left()` など。キーボードとゲームパッドを hp.js がまとめ、A／Bボタンという抽象化もここ）。rustgames はページ側 JavaScript がビットマスクで渡す自前プロトコル（WASM の境界を越えるので、関数呼び出しの形も自前）。
- 「左右の差分を取る」書き方も好対照です。Python／pyxel-rust は `if` で増減。JavaScript は三項演算子で 1／0 にして引き算。rustgames は `bool` を `as i32` に変換して引き算で、JavaScript の三項演算子で 1／0 にして引く形は、この「引き算で左右を取る」発想を JS の書き方に直したものと読めます。
- 戻り値の扱い: Python／pyxel-rust は `(dx, dy)` を返す専用関数があります。JavaScript／rustgames は更新処理の中で直接読みます。

---

## 4. 壁判定 ― 「部屋」をどこから読むか

**Python**（`Cubeboy.py` 84 行目〜、`Player.is_wall`）

```python
    def is_wall(self, x, y):
        # Standardize check with small padding
        x1 = int(x // 8)
        y1 = int(y // 8)
        x2 = int((x + self.width - 0.1) // 8)
        y2 = int((y + self.height - 0.1) // 8)
        
        for ty in range(y1, y2 + 1):
            if not (0 <= ty < 16): continue # Allow passing vertical bounds
            for tx in range(x1, x2 + 1):
                if not (0 <= tx < 16): continue # Allow passing horizontal bounds
                if pyxel.tilemaps[0].pget(tx, ty) == (1, 0):
                    return True
        return False
```

**pyxel-rust**（`cubeboy.rs` 156 行目〜、`Player::is_wall`）

```rust
    fn is_wall(&self, x: f32, y: f32, room: &Room) -> bool {
        let x1 = (x / TILE_SIZE as f32).floor() as i32;
        let y1 = (y / TILE_SIZE as f32).floor() as i32;
        let x2 = ((x + self.width - 0.1) / TILE_SIZE as f32).floor() as i32;
        let y2 = ((y + self.height - 0.1) / TILE_SIZE as f32).floor() as i32;

        for ty in y1..=y2 {
            if ty < 0 || ty >= 16 {
                continue;
            }
            for tx in x1..=x2 {
                if tx < 0 || tx >= 16 {
                    continue;
                }
                if room.is_solid(tx as usize, ty as usize) {
                    return true;
                }
            }
        }
        false
    }
```

**JavaScript**（`index.html` 108 行目〜、`isWall`）

```js
function isWall(p,x,y){
  const x1=Math.floor(x/8),y1=Math.floor(y/8);
  const x2=Math.floor((x+p.w-0.1)/8),y2=Math.floor((y+p.h-0.1)/8);
  for(let ty=y1;ty<=y2;ty++){
    if(ty<0||ty>=16)continue;
    for(let tx=x1;tx<=x2;tx++){
      if(tx<0||tx>=16)continue;
      if(tm[ty*16+tx]===1)return true;
    }
  }
  return false;
}
```

**rustgames**（`cubeboy.rs` 415 行目〜、`CubeBoyGame::is_wall`）

```rust
    fn is_wall(&self, x: f32, y: f32) -> bool {
        let p = &self.player;
        let x1 = (x / TS).floor() as i32;
        let y1 = (y / TS).floor() as i32;
        let x2 = ((x + p.w - 0.1) / TS).floor() as i32;
        let y2 = ((y + p.h - 0.1) / TS).floor() as i32;
        for ty in y1..=y2 {
            if ty < 0 || ty >= 16 {
                continue;
            }
            for tx in x1..=x2 {
                if tx < 0 || tx >= 16 {
                    continue;
                }
                if self.tm[(ty * 16 + tx) as usize] == 1 {
                    return true;
                }
            }
        }
        false
    }
```

**何が違うか**

- 判定ロジックは4方式とも同じです（プレイヤーの矩形が重なるタイルを舐めて、固体（1）なら true）。範囲外を `continue` で素通りさせる点まで同じです。
- 一番の違いは部屋データの出どころです。Python はエンジンのタイルマップ `pyxel.tilemaps[0]` を直接参照するので、メソッドの引数は座標だけ。pyxel-rust は部屋を `Room` 構造体が所有し、`&Room` で借りて渡す。JavaScript はグローバル変数 `tm`（現在の部屋のタイル配列 256 要素）を直接読む。rustgames は `CubeBoyGame` 自身のフィールド `self.tm` を読むので、引数も借用も要りません。
- 部屋の持ち方自体も違います。Python は Pyxel のタイルマップ（リソースとして用意されたもの）。pyxel-rust は `Room` がタイル配列を所有し、中身は `generate_room` がその場で簡易に作ります（縁＋ランダムな壁）。JavaScript／rustgames は「部屋に入るたびシードから生成する」方式で、複数ルームを行き来する構造になっています（`genRoom`／`gen_room`）。この決定的なシード生成は rustgames 版で形になり、JavaScript 版が乱数列ごと引き継いだものです。

---

## 5. プレイヤーの更新 ― ダッシュ処理の対応

**Python**（`Cubeboy.py` 117 行目〜、`Player.update` のダッシュ部分）

```python
        # Dash logic
        if self.dash_time > 0:
            self.vx = self.dash_dir[0] * 5
            self.vy = self.dash_dir[1] * 5
            self.dash_time -= 1
            # Particles
            particles.append(Particle(self.x + 3, self.y + 3, pyxel.rndf(-1, 1), pyxel.rndf(-1, 1), COLOR_PARTICLE, 10))
            if self.dash_time == 0:
                self.vx *= 0.5
                self.vy *= 0.5
```

**pyxel-rust**（`cubeboy.rs` 209 行目〜、`Player::update` のダッシュ部分）

```rust
        // Dash logic
        if self.dash_time > 0 {
            self.vx = self.dash_dir.0 * 5.0;
            self.vy = self.dash_dir.1 * 5.0;
            self.dash_time -= 1;

            particles.push(Particle::new(
                self.x + 3.0,
                self.y + 3.0,
                rnd(-1.0, Some(1.0)),
                rnd(-1.0, Some(1.0)),
                COLOR_PARTICLE,
                10,
            ));

            if self.dash_time == 0 {
                self.vx *= 0.5;
                self.vy *= 0.5;
            }
        }
```

**JavaScript**（`index.html` 137 行目〜、`updPlayer` のダッシュ部分）

```js
  if(p.dashTime>0){
    p.vx=p.dashDir[0]*5;p.vy=p.dashDir[1]*5;p.dashTime--;
    parts.push({x:p.x+3,y:p.y+3,dx:Math.random()*2-1,dy:Math.random()*2-1,col:C_CYAN,life:10});
    if(p.dashTime===0){p.vx*=0.5;p.vy*=0.5}
  }
```

**rustgames**（`cubeboy.rs` 524 行目〜、`update_player` のダッシュ部分）

```rust
        if self.player.dash_time > 0 {
            self.player.vx = self.player.dash_dir.0 * 5.0;
            self.player.vy = self.player.dash_dir.1 * 5.0;
            self.player.dash_time -= 1;
            let (cx, cy) = (self.player.x + 3.0, self.player.y + 3.0);
            let dx = self.rng.range_f32(-1.0, 1.0);
            let dy = self.rng.range_f32(-1.0, 1.0);
            self.parts.push(Particle { x: cx, y: cy, dx, dy, col: C_CYAN, life: 10 });
            if self.player.dash_time == 0 {
                self.player.vx *= 0.5;
                self.player.vy *= 0.5;
            }
        }
```

**何が違うか**

- ロジックと数値は4方式とも同一です（速度 5 倍、終わりに 0.5 倍、粒子は life 10）。ゲームの手触りの核が、方式を越えてそのまま運ばれていることが一番よく分かる箇所です。
- 粒子の色が系譜を表します。Python／pyxel-rust は色定数 `COLOR_PARTICLE`（=12、パレット番号）。JavaScript／rustgames は `C_CYAN`（色の値）。色の値で持つやり方は rustgames 版から JavaScript 版へ引き継がれました（rustgames 版の冒頭コメントには「JS の移植」と書かれていますが、開発順は著者によれば逆です。冒頭の系統の節を参照）。
- 乱数の出どころが4方式で違います。Python はエンジンの `pyxel.rndf(-1, 1)`。pyxel-rust は互換 API の `rnd(-1.0, Some(1.0))`（省略できる引数を `Option` で表す流儀）。JavaScript は `Math.random()`（粒子のような見た目専用の乱数は、再現性なしで済ませている）。rustgames は自前の `GameRng`（`self.rng.range_f32(-1.0, 1.0)`）。ただし部屋生成のような再現性が要る乱数は、rustgames は専用の `JsRng` を別に用意しています（`rng.rs`）。JavaScript 版の乱数列はこれと同一で、開発順では JavaScript が rustgames の乱数列を引き継いでいます（`JsRng` という名前とコメントは JS に言及していますが、向きは著者によれば rustgames → JavaScript です）。
- rustgames は `self.player.` の連なりが長くなります。`CubeBoyGame` がプレイヤーをフィールドとして所有し、`&mut self` のメソッドの中で触るためです。コメントにも「プレイヤー状態を一時的に取り出して更新する（借用回避のため手続き的に書く）」とあり、借用の都合が書き方に出ています。

---

## 6. ゲーム全体の進行 ― 状態遷移の書き方

**Python**（`Cubeboy.py` 548 行目〜、`App.update` の冒頭）

```python
    def update(self):
        if self.state == STATE_START:
            if (pyxel.btnp(pyxel.KEY_SPACE) or pyxel.btnp(pyxel.KEY_Z) or 
                pyxel.btnp(pyxel.KEY_X) or pyxel.btnp(pyxel.KEY_RETURN) or
                pyxel.btnp(pyxel.GAMEPAD1_BUTTON_A) or pyxel.btnp(pyxel.GAMEPAD1_BUTTON_START)):
                self.state = STATE_PLAY
                self.play_random_bgm()
            return
```

この後に GAMEOVER／GAMECLEAR の受付、BGM のクロスフェード処理、死亡演出（STATE_GAMEOVER_SEQ）までが同じ `update` に続き、`App.update` は全体で約 150 行あります。

**pyxel-rust**（`cubeboy.rs` 449 行目〜、`Game::update` 全体）

```rust
    fn update(&mut self) {
        match self.state {
            STATE_PLAY => {
                self.player.update(&self.room, &mut self.particles);
                self.particles.retain_mut(|p| {
                    p.update();
                    p.is_alive()
                });
            }
            STATE_BOSS => {
                self.player.update(&self.room, &mut self.particles);
                self.boss.update();
            }
            _ => {}
        }
    }
```

**JavaScript**（`index.html` 443 行目〜、シーンの登録と切替）

```js
const SC=HP.scene({title:{frame:stepTitle},main:{frame:stepMain},overseq:{frame:stepSeq},over:{frame:stepEnd},clear:{frame:stepEnd}},"title");
function go(name){state=name;SC.go(name==="boss"||name==="play"?"main":name)}
```

**rustgames**（`cubeboy.rs` 486 行目〜、`step`）

```rust
    fn step(&mut self) {
        self.frame += 1;
        let a_edge = self.input.a && !self.prev_a;
        let b_edge = self.input.b && !self.prev_b;
        self.prev_a = self.input.a;
        self.prev_b = self.input.b;
        let tap_now = self.tap_pending;
        self.tap_pending = false;
        let start_pressed = self.input.a || a_edge || tap_now;
        match self.scene {
            Scene::Title => {
                if start_pressed {
                    self.reset_game();
                }
            }
            Scene::Main => self.step_main(a_edge, b_edge, tap_now),
            Scene::OverSeq => self.step_seq(),
            Scene::Over | Scene::Clear => {
                if start_pressed {
                    self.reset_game();
                }
            }
        }
    }
```

**何が違うか**

- 状態の持ち方が4通りです。Python は数値定数 6 個を `if` の連鎖で振り分け。pyxel-rust は数値定数 3 個を `match` で振り分け（対象はプレイとボスの 2 状態だけ）。JavaScript は文字列の状態（`"title"`、`"play"`、`"boss"`、`"overseq"`、`"over"`、`"clear"`）と、hp.js のシーン管理（`HP.scene`）の二層になっていて、`go()` がゲーム側の状態名をシーン名へ寄せています（`"play"` と `"boss"` は同じ `"main"` シーン）。rustgames は `enum Scene` の 5 変種（Title／Main／OverSeq／Over／Clear）を `match` で振り分け、ボス戦かどうかは `boss_mode` フラグで別に持ちます。JavaScript の「状態文字列＋シーン名」の二層を、enum＋フラグに整理し直した形です。
- 粒子の更新と消去も対照的です。pyxel-rust は `retain_mut` にクロージャを渡して「更新しながら残す」を 1 箇所で書きます。JavaScript は `for` で回してから `filter` で残す（2 節）。rustgames は `update_particles` の中で `iter_mut` で回してから `retain` する、JavaScript の書き方に近い2段構えです。
- 規模の違いも出ます。Python の `App.update` は全状態＋BGM 制御で約 150 行。pyxel-rust の `update` は上の 16 行だけです。JavaScript の `stepMain` と rustgames の `step_main` は、ボス出現カウントダウン、部屋遷移、オーブ判定まで含む本編の処理として対応しています。

---

## 7. 起動とメインの回し方

**Python**（`Cubeboy.py`、`App.__init__` の冒頭と末尾。間はイメージバンク・サウンド・BGM・状態の初期化）

```python
class App:
    def __init__(self):
        pyxel.init(W, H, title="CubeBoy")
        # …（中略: グラフィックと音の準備、状態変数の初期化、部屋の生成）…
        pyxel.run(self.update, self.draw)
```

**pyxel-rust**（`cubeboy.rs` 495 行目〜、`main` 全体）

```rust
fn main() {
    init(W, H, "Cubeboy Rust", 60);
    
    let game = std::rc::Rc::new(std::cell::RefCell::new(Game::new()));
    
    let game_update = std::rc::Rc::clone(&game);
    let game_draw = std::rc::Rc::clone(&game);
    
    run(
        move || {
            game_update.borrow_mut().update();
        },
        move || {
            game_draw.borrow().draw();
        },
    );
}
```

**JavaScript**（`index.html` 454 行目〜、ファイル末尾）

```js
// fixed-step loop (30Hz, same feel as the original)
player=mkPlayer(64,64);boss=mkBoss();tm=genRoom(0,0);
let acc=0;
HP.loop(function(dt){
  acc+=dt;
  const h=1/30;let n=0;
  while(acc>=h&&n<4){step();acc-=h;n++}
  if(n===4)acc=0;
});
```

**rustgames**（駆動は `lib.rs` 503 行目〜と 511 行目、本体の `tick` は `cubeboy.rs` 464 行目〜）

```rust
#[wasm_bindgen]
pub async fn init_cubeboy(canvas_id: &str) {
    console_error_panic_hook::set_once();
    match cubeboy::CubeBoyGame::new(canvas_id).await {
        Ok(g) => CUBEBOY.with(|s| *s.borrow_mut() = Some(g)),
        Err(e) => web_sys::console::error_1(&e.into()),
    }
}

#[wasm_bindgen] pub fn tick_cubeboy(ts: f64) { CUBEBOY.with(|s|{if let Some(g)=s.borrow_mut().as_mut(){g.tick(ts);}}); }
```

```rust
    pub fn tick(&mut self, ts: f64) {
        if self.prev_ts == 0.0 {
            self.prev_ts = ts;
        }
        let dt = ((ts - self.prev_ts) / 1000.0).min(0.25);
        self.prev_ts = ts;
        self.acc += dt;
        let h = 1.0 / 30.0;
        let mut n = 0;
        while self.acc >= h && n < 4 {
            self.step();
            self.acc -= h;
            n += 1;
        }
        if n == 4 {
            self.acc = 0.0;
        }
        self.draw();
        let clear = C_BG;
        self.renderer.render(&self.draw, clear);
    }
```

**何が違うか**

- Python／pyxel-rust は「init して、update と draw の 2 関数をエンジンに渡す」が骨格です。エンジン側がフレームの刻みを決めます。Python は `self.update` とメソッド参照をそのまま渡せますが、pyxel-rust は update（書き換える）と draw（読む）で同じ `Game` を共有するため、`Rc<RefCell<Game>>` に包んでクロージャで借り分ける定型が要ります。
- JavaScript／rustgames は「固定ステップを自前で回す」が骨格です。どちらも経過時間を `acc` に蓄積し、1/30 秒ごとに `step()` を消化して、回しすぎたら（4 回）蓄積を捨てる、という同じコードになっています。この固定ステップの骨格は rustgames の `tick` と JavaScript の `HP.loop` で同じ形をしていて、開発順から見れば JavaScript 側が rustgames の回し方を引き継いだものと読めます。ここにも移植の系統が見えます。違いは、JavaScript ではループの駆動が hp.js（`HP.loop`）で、rustgames ではページ側 JavaScript が `tick_cubeboy` を requestAnimationFrame で呼び、本体側が「ステップ消化＋描画＋レンダラーへの提出」までを1回に担う点です。
- 起動の重さも違います。pyxel-rust の `main` は同期的ですが、rustgames の `CubeBoyGame::new` は `async` です。wgpu レンダラー（`Renderer2d::new(canvas, VW, VH).await`）の準備が非同期だからで、GPU の土台を持つ方式ならではの形です。

---

## 対応表（まとめ）

| 観点 | 本家 Pyxel（Python） | pyxel-rust（Rust） | 素の JavaScript | rustgames（Rust） |
|---|---|---|---|---|
| API 呼び出し | `pyxel.btn(pyxel.KEY_LEFT)` とモジュール修飾 | `btn(KEY_LEFT)` と prelude 経由で修飾なし | `HP.left()`（プレイヤー共通部品）／描画は Canvas 2D 直接 | `self.input.left`（自前の入力構造体）／ページ側 JS がマスクで供給 |
| データ定義 | `class`＋`__init__` で `self.` に代入 | `struct` 宣言＋`impl` の `new` | 生成関数がオブジェクトリテラルを返す | `struct` 宣言＋`impl` の `new`。全体は `CubeBoyGame` に集約 |
| 色の持ち方 | パレット番号（定数） | パレット番号（定数） | 色の値（文字列） | 色の値（`Rgba::hex`） |
| 部屋データ | `pyxel.tilemaps[0]` を直接参照 | `Room` 構造体が所有し `&Room` で渡す | グローバル `tm`（シードから生成） | `self.tm`（シードから生成、JS 版と同一規則） |
| 状態遷移 | 定数 6 個を `if` の連鎖 | 定数 3 個を `match` | 文字列の状態＋hp.js のシーン管理 | `enum Scene` 5 変種を `match`＋`boss_mode` フラグ |
| 乱数 | エンジンの `rndf` | 互換 API の `rnd`（`Option` 流儀） | `Math.random()`（見た目用） | 自前 `GameRng`。部屋生成は `JsRng`（JavaScript 版と同一列） |
| フレームの回し方 | エンジンの `run` が update／draw を呼ぶ | 互換 API の `run` にクロージャを渡す | hp.js のループ＋自前の固定ステップ | ページ側が `tick` を呼び、本体が固定ステップ＋描画 |
| 起動 | `pyxel.run(self.update, self.draw)` | `run(クロージャ, クロージャ)`。共有は `Rc<RefCell<…>>` | 初期化コードを書いて `HP.loop` に渡すだけ | `init_cubeboy`（非同期）→ ページ側が `tick_cubeboy` を回す |
| 規模 | 780 行（全状態＋BGM＋複数ルーム管理） | 511 行（プレイ＋ボス中心） | 464 行（HTML 全体。タイトル〜クリア＋複数ルーム＋ボス） | 973 行（cubeboy.rs のみ。タイトル〜クリア＋複数ルーム＋ボス。基盤側は別） |

## 系統ごとに見える、残ったものと落ちたもの（コードから確認できた範囲）

- **Python → pyxel-rust で落ちたもの**: タイトル画面（STATE_START）、ゲームオーバーとその演出（STATE_GAMEOVER／同 SEQ）、BGM の MP3 クロスフェード再生（`play_random_bgm` 一式）、複数ルーム管理（`rooms_data` 辞書）、Orb クラス（色定数とカウンタだけ残る）、ゲームパッド入力。部屋はタイルマップ資産ではなくなり、`generate_room` がその場で作る簡易な生成（縁＋ランダムな壁）に変わりました。BGM が落ちたのはこの段で、以後の版にも戻っていません。
- **pyxel-rust → rustgames で変わったもの**: 部屋生成が、部屋の座標をシードにする決定的な生成（FNV-1a ハッシュ＋mulberry32）になりました。pyxel-rust で落ちていた複数ルームや、タイトルからクリアまでの状態の顔ぶれも、この版のコードにはあります。描画は wgpu のバッチ層へ替わり、音は `audio_event` という番号をページ側へ返す方式（再生自体は WASM の外）になりました。
- **rustgames → JavaScript で引き継がれたもの**: 部屋生成の規則と乱数列、状態の顔ぶれ、固定ステップの回し方、描画の組み立て（プレイヤーの伸縮と目の位置まで同じ）、タイトル／ゲームオーバー／クリア、オーブ、ボス、画面シェイク。変わったのは「置き場」で、型のある構造体と enum がグローバル変数とオブジェクトリテラルに散り、描画が wgpu のバッチ層から素の Canvas 2D に、効果音が beep になりました。物理の数値は原作のままです。

4方式とも、プレイヤーの物理（コヨーテタイム、ジャンプバッファ、ダッシュ、壁ずり）の核は同じ名前・同じ数値で実装されています。「手触りの核は運び、土台と周辺の作りが方式ごとに替わる」というのが、コードから読み取れる全体像です。
