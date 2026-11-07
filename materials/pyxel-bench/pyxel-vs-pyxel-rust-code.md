# Pyxel と pyxel-rust、ソースコード見比べ ― CubeBoy

> 4方式版を作りました。素の JavaScript と rustgames を加えたコードの見比べは [four-ways-code.md](four-ways-code.md)、仕組みの比較は [four-ways-mechanism.md](four-ways-mechanism.md) を参照してください。

同じゲーム「CubeBoy」を、Pyxel（Python）版と pyxel-rust（Rust）版の両方で実装したソース同士の見比べ資料。仕組み全体の違いは [pyxel-vs-pyxel-rust.md](pyxel-vs-pyxel-rust.md) を参照。ここではコードそのものを並べる。

## 使ったソース

| | ファイル | 行数 |
|---|---|---|
| Python 版 | `~/workspace/html-player/games/cube-boy-pyx/index.html` に埋め込まれた `Cubeboy.pyxapp` 内の `Cubeboy/Cubeboy.py`（抽出コピー: `~/workspace/pyxel-bench/src-python/cubeboy/Cubeboy.py`） | 780 行 |
| Rust 版 | `~/workspace/pyxel-bench/src/pyxel-rust/examples/cubeboy.rs`（`docs/examples/cubeboy.rs` と同一内容） | 511 行 |

定数の名前もクラス構成もほぼ 1 対 1 で対応しており、Rust 版は Python 版の移植だとコードから読み取れる。ただし完全な移植ではなく、簡略化されている部分がある（後述）。

---

## 1. 定数定義 ― 名前は同じ、型の書き方が違う

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

**Rust**（`cubeboy.rs` 冒頭）

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

**何が違うか**

- Rust は `const 名前: 型 = 値;` と、定数ごとに型（ここでは全部 `u32`）を書く。Python は値だけ。
- 状態（STATE_）の数が違う。Python は START／GAMEOVER／GAMEOVER_SEQ まで 6 つあるが、Rust は 3 つだけ。タイトル画面やゲームオーバー画面が Rust 版には無いことの現れ（6 節参照）。
- Rust の 1 行目 `use pyxel_rust::prelude::*;` が、この後の API 呼び出しの見た目を決める（3 節参照）。

---

## 2. データの持ち方 ― class と struct

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

**Rust**（`cubeboy.rs` 26 行目〜）

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

**何が違うか**

- Python は `__init__` の中で `self.x = x` と代入して初めてフィールドが決まる。Rust は `struct` でフィールドと型を先に全部宣言し、`impl` の `new` が生成役、`update` や `draw` がメソッド役になる（データ定義と処理が分かれる）。
- 書き換えるメソッドには `&mut self`、読みだけのメソッドには `&self` と、借用の形が署名に現れる。Python の `self` はその区別を書かない。
- `#[derive(Clone, Copy)]` は「この構造体はコピーして渡してよい」という宣言。所有権のある言語ならではの行で、Python には対応物が無い。
- 描画は `pyxel.pset(...)` と `pset(...)` で、呼びたい関数は同じ。色の値を `as u8` と変換しているのは、定数側が `u32`、 API 側が `u8` を受けるため。Python はそのまま渡せる。
- Rust には `is_alive()` が増えている。粒子の消去をリスト操作側（`retain_mut`、6 節）から使うため。

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

**Rust**（`cubeboy.rs` 113 行目〜、`struct Player`。初期化は続く `fn new` で同じ順に値を入れる）

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

**何が違うか**

- フィールドは名前も順番もほぼ同じ。移植であることが一番よく分かる箇所。
- Python は `self.width = 6`（整数）でも `float(x)` と混ざっても動くが、Rust は座標・速度は `f32`、タイマー類は `i32`、真偽は `bool` と全フィールドに型が付く。
- コメントで「-1 left, 1 right, 0 none」と説明していた `is_on_wall` のような「数値で状態を表す」流儀は、Rust でも `i32` のまま引き継がれている（enum にはしていない）。

---

## 3. 入力の受け方 ― API 呼び出しの対応関係

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

**Rust**（`cubeboy.rs` 178 行目〜、`Player::get_input`）

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

**何が違うか**

- 対応関係はそのまま: `pyxel.btn(pyxel.KEY_LEFT)` ↔ `btn(KEY_LEFT)`。Pyxel ではモジュール名 `pyxel.` と定数名 `pyxel.KEY_…` を毎回書く。pyxel-rust は冒頭の `use …::prelude::*` で関数と定数を読み込んであるので、修飾なしで書ける。
- 戻り値はどちらも「(dx, dy) の組」で、Rust は署名に `-> (i32, i32)` と書く。変数宣言も `let mut dx = 0i32;` と、書き換える変数には `mut` が付く。
- Python 版はゲームパッドの十字キー（`GAMEPAD1_BUTTON_DPAD_*`）も見ているが、Rust 版はキーボードのみ。この入力でも移植の簡略化が出ている。

---

## 4. 壁判定 ― 「部屋」をどう渡すか

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

**Rust**（`cubeboy.rs` 156 行目〜、`Player::is_wall`）

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

**何が違うか**

- 判定ロジック自体は同じ（4 隅のタイルを舐めて、固体なら true）。
- 一番の違いは部屋データの出どころ。Python は `pyxel.tilemaps[0]` というエンジン側のタイルマップを直接参照するので、メソッドの引数は座標だけ。Rust は `room: &Room` と、部屋を引数で受け取る。Rust 版では部屋は `Room` 構造体（`tiles: Vec<Vec<u32>>` を持ち、`is_solid` などのメソッドを持つ）が所有していて、使う側は借りて読む。この「引数で借りて渡す」形が、所有権のある言語の署名の典型。
- そのため Python の `Player.update(self, particles)` には部屋の引数が無い（タイルマップはグローバルに届く）が、Rust の `Player::update(&mut self, room: &Room, particles: &mut Vec<Particle>)` には部屋と粒子の両方が並ぶ。
- 範囲の書き方も好対照: `range(y1, y2 + 1)` ↔ `y1..=y2`、`int(x // 8)` ↔ `(x / TILE_SIZE as f32).floor() as i32`。

---

## 5. プレイヤーの更新 ― ダッシュ処理の 1 行ずつの対応

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

**Rust**（`cubeboy.rs` 209 行目〜、`Player::update` のダッシュ部分）

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

**何が違うか**

- ロジックはほぼ逐語訳。タプルの要素アクセスが `dash_dir[0]` → `dash_dir.0`、リストへの追加が `append(...)` → `push(...)`、生成が `Particle(...)` → `Particle::new(...)`。
- 乱数が好対照: `pyxel.rndf(-1, 1)` ↔ `rnd(-1.0, Some(1.0))`。pyxel-rust の `rnd` は第 2 引数を `Option` で受ける形になっていて、「省略できる引数」を Python のデフォルト引数ではなく `Some(...)`／`None` で表している。効果音の再生も同じ流儀で、Rust 版は `play(3, 0, None, None, None);`（`cubeboy.rs` 264 行目）という呼び方になる。
- 数値リテラルは Rust では型に合わせて `5` → `5.0`、`3` → `3.0` と小数点が付く。

---

## 6. ゲーム全体の進行 ― 状態遷移と update／draw

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

この後に GAMEOVER／GAMECLEAR の受付、BGM のクロスフェード処理、死亡演出（STATE_GAMEOVER_SEQ）までが同じ `update` に続き、`App.update` は全体で約 150 行ある。`draw` 側もタイトル画面・ゲームオーバー画面・背景（月と山並み）・画面シェイクまで描く。

**Rust**（`cubeboy.rs` 449 行目〜、`Game::update` 全体）

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

**何が違うか**

- 状態の振り分けが、Python の `if` の連鎖に対して Rust は `match` 式。`_ => {}` で「それ以外は何もしない」を明示する。
- 粒子の更新と消去: Python は各所で `for p in self.particles: p.update()` と回し、残す条件は別の場所で処理する。Rust は `retain_mut` にクロージャを渡して「更新しながら、生きているものだけ残す」を 1 箇所で書いている（2 節の `is_alive()` はこのため）。
- 規模の違いが一番出る節でもある。Python は「タイトル→プレイ→ボス→死亡演出→ゲームオーバー→クリア」の全状態＋BGM 制御を持ち、Rust はプレイとボスの 2 状態だけを回す。`Game` 構造体のフィールドも、Python の `App` が持つ `rooms_data`（複数ルームを辞書で管理）、`orbs`（リスト）、`shake`、BGM 関係一式が無く、`room` 1 つに置き換わっている。

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

**Rust**（`cubeboy.rs` 495 行目〜、`main` 全体）

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

**何が違うか**

- どちらも「init して、update と draw の 2 関数をエンジンに渡す」が骨格で、Pyxel の作法がそのまま pyxel-rust に引き継がれている。
- `init` の引数: Python は `title="CubeBoy"` とキーワード引数。Rust は位置引数で、fps（60）まで渡している。タイトル文字列も "Cubeboy Rust" と版名に変わっている。
- Python は `self.update` とメソッド参照をそのまま渡せる。Rust は update（書き換える）と draw（読む）で同じ `Game` を共有するため、`Rc<RefCell<Game>>` に包んで複製し、クロージャの中で `borrow_mut()`／`borrow()` と借り分ける。「1 つの所有物を、書き手と読み手で安全に共有する」ための定型が、このゲームで一番 Rust らしい数行になっている。

---

## 対応表（まとめ）

| 観点 | Pyxel（Python） | pyxel-rust（Rust） |
|---|---|---|
| API 呼び出し | `pyxel.btn(pyxel.KEY_LEFT)` とモジュール修飾 | `btn(KEY_LEFT)` と prelude 経由で修飾なし |
| データ定義 | `class`＋ `__init__` で `self.` に代入 | `struct` 宣言＋ `impl` の `new` |
| 書き換えの明示 | `self` のみ | `&mut self`／`&self` と署名に書く |
| 部屋データ | `pyxel.tilemaps[0]` を直接参照（引数不要） | `Room` 構造体が所有し、`&Room` で渡す |
| 状態遷移 | 定数 6 個を `if` の連鎖で振り分け | 定数 3 個を `match` で振り分け |
| リスト操作 | `append` | `push`。更新＋消去は `retain_mut`＋クロージャ |
| 省略できる引数 | デフォルト引数 | `Option`（`Some(1.0)`／`None`） |
| 起動 | `pyxel.run(self.update, self.draw)` | `run(クロージャ, クロージャ)`。共有は `Rc<RefCell<…>>` |
| 規模 | 780 行（全状態＋BGM＋複数ルーム管理） | 511 行（プレイ＋ボス中心） |

## 移植で簡略化されている部分（コードから確認できた範囲）

- 状態遷移: タイトル画面（STATE_START）、ゲームオーバーとその演出（STATE_GAMEOVER／同 SEQ）が無い。
- BGM: Python 版の MP3 クロスフェード再生（`play_random_bgm` 一式）が無い。効果音の `play(...)` はある。
- 部屋: Python 版は `rooms_data` 辞書＋ `room_x／room_y` で複数ルームを管理し、部屋ごとにオーブ取得済みかを `set` で記録する。Rust 版は `Room` 1 つだけ。
- オーブ: Python 版には `Orb` クラス（取得でダッシュ回復）がある。Rust 版は色定数と `collected_orbs` カウンタと表示だけが残り、実体が無い。
- 入力: ゲームパッド対応が無い（3 節）。

逆に、プレイヤーの物理（コヨーテタイム、ジャンプバッファ、ダッシュ、壁ずり）の核の部分は両版とも同じ名前・同じ数値で実装されており、「ゲームの手触りの核は移植し、周辺は切り落とした」という切り分けがコードから読み取れる。
