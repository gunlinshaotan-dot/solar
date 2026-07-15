# Solar Nemesis

Интерактивная 3D Солнечная система (Three.js) — полёт из кабины корабля.

**Онлайн:** [https://gunlinshaotan-dot.github.io/solar/](https://gunlinshaotan-dot.github.io/solar/)

## Управление

### ПК
- **Мышь** — поворот корабля
- **Alt + мышь** — осмотр кабины / кнопки
- **WASD** — тяга · **Q/E** — крен · **X** — тормоз
- **Shift** — ускорение · **M / MAP** — карта и варп · **HYPER** — прицел-прыжок
- **F** — встать/сесть · **H** — скрыть HUD

### Android / телефон
- Открой ссылку в Chrome → «Взять штурвал»
- **Джойстик** — тяга · **свайп** — поворот
- **MAP** — карта / варп · **ВЗЛЁТ** — с поверхности

## Локальный запуск

Дважды кликни **`start.bat`** или:

```bash
npm start
# или
node server.js
```

Открой [http://127.0.0.1:3000](http://127.0.0.1:3000)

При правках страницу можно обновлять вручную (F5).

Авто-reload выключен по умолчанию (на Windows он ложно срабатывал). Включить:

```bash
set LIVE_RELOAD=1
node server.js
```


## Структура

```
index.html · css/style.css · js/game.js · textures/ · sounds/ · server.js · start.bat · sw.js
```
