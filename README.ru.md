# Discord Presence для DeepSeek Harness

[![English](https://img.shields.io/badge/README-English-8b949e?style=for-the-badge)](README.md)
[![Русский](https://img.shields.io/badge/README-%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-2f81f7?style=for-the-badge)](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3fb950?style=flat-square)](#требования)
[![Tests](https://img.shields.io/badge/tests-48%20passing-3fb950?style=flat-square)](#тесты)
[![Dependencies](https://img.shields.io/badge/dependencies-0-3fb950?style=flat-square)](#файлы)
[![Discord Rich Presence](https://img.shields.io/badge/Discord-Rich%20Presence-5865F2?style=flat-square)](#)

---

Плагин показывает в Discord (Rich Presence), что харнес запущен: над каким проектом он
работает, сколько уже крутится, сколько сожрал токенов, сколько сделал ходов и вызовов
инструментов. Плюс — по желанию — пишет машинно-читаемый `status.json` и постит embed
в канал Discord на каждый завершённый ход.

Ноль зависимостей: только стандартная библиотека Node и нативный Discord IPC (именованный
пайп на Windows, unix-сокет на Linux/macOS). Никакого `discord-rpc`, ничего не надо собирать.

```
┌──────────────────────────────────────────────┐
│ default-workspace                            │  ← details
│ waiting for a task                           │  ← state
│ default-workspace · 0 turns · 0 tools        │  ← largeText (hover)
│ · session 06b20207                           │
└──────────────────────────────────────────────┘
```

Во время работы:

```
┌──────────────────────────────────────────────┐
│ dsh-discord-presence                         │
│ deepseek/deepseek-v4.1-flash · 1.2M tokens   │
│ 4 turns · 17 tools · session 06b20207        │
└──────────────────────────────────────────────┘
```

Карточка полностью на английском и без смайликов; имя проекта берётся из папки как есть,
в оригинальном языке (`default-workspace`, `мой-проект`). Состояние показывается словами:
`running` — харнес запущен, сессий ещё нет; `idle` — сессия простаивает; `working` — идёт ход;
`waiting for a task` — сессия создана, но ещё ничего не делала. Русские строки остались
доступны через `language: ru`, но по умолчанию язык английский.

---

## Требования

* Node.js 20+ (у харнеса свой рантайм, так что обычно он уже есть).
* Запущенный **desktop**-клиент Discord на той же машине — из браузера Rich Presence не работает.
* Discord Application ID — см. следующий раздел.

---

## Быстрый старт

1. Открой <https://discord.com/developers/applications> → **New Application** →
   назови как угодно (например `DeepSeek Harness`). Это просто «контейнер» для карточки,
   бота создавать не нужно.
2. **General Information** → **Application ID** → Copy. Это число из 18–19 цифр.
3. Вставь его в настройки плагина — любым из двух способов:
   * **GUI**: Settings → Plugins → `discord-presence` → поле **Client ID** → сохранить;
   * **файл**: добавь override-строку в `<DSH_HOME>\profiles\<профиль>\cordis.patch.yml`:

     ```yaml
     - id: discord-presence
       name: 'dsh-discord-presence'
       config:
         clientId: '123456789012345678'
     ```

4. Перезапусти харнес: строка плагина читается из `dsh.profile.bundles` на старте.
5. Discord **desktop** должен быть запущен — Rich Presence не работает из браузера.

Своя картинка (необязательно): в приложении → **Rich Presence → Art Assets** загрузи PNG
с ключом, например `harness`, и поставь `largeImage: harness`. Либо просто впиши
https-ссылку на картинку в `largeImage`. Пусто — картинки нет.

---

## Что попадает в карточку

| Поле | Откуда берётся |
| --- | --- |
| проект | последний сегмент `cwd` активной сессии (у субагентов — родительский проект) |
| `workspace` | полный `cwd` |
| модель / провайдер | `session.requestContext()` и события `request/context` |
| токены | сумма по всем сессиям: `uncachedInput + cacheRead + cacheWrite + output` |
| ходы / шаги / инструменты | фолд событий `turn/*`, `step/*`, `tool/call` |
| elapsed | время жизни активной сессии (для восстановленных — не раньше старта процесса) |
| uptime | время жизни процесса харнеса |
| sessions / subagents | сколько сессий живо и сколько из них субагенты |
| статус | `running` / `idle` / `working` / `waiting for a task` |

Активная сессия выбирается так: сначала та, что сейчас выполняет ход, иначе самая свежая
корневая (субагент никогда не становится заголовком карточки).

Если в композиции есть проекция `tokenUsage` (`ctx.sessionProjections`), счётчики берутся
из неё — это официальные цифры провайдера. Если проекции нет, плагин считает сам по
событиям `assistant/message`. В `status.json` видно, какой источник сработал: `usage.source`
= `projection` или `fold`.

---

## Настройки

Все поля живые (правятся без перезапуска) и описаны прямо в карточке настроек.

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `enabled` | `true` | Показывать харнес в Discord вообще |
| `clientId` | `''` | Application ID; без него карточки не будет |
| `language` | `en` | Язык карточки: `en` или `ru`. Имя проекта не переводится никогда |
| `showModel` | `true` | Показывать модель |
| `showTokens` | `true` | Показывать токены |
| `showTurns` | `true` | Показывать число ходов |
| `showTools` | `true` | Показывать число вызовов инструментов |
| `detailsTemplate` | `''` | Полная замена первой строки (см. плейсхолдеры) |
| `stateTemplate` | `''` | Полная замена второй строки |
| `largeImage` | `''` | Ключ ассета в приложении или https-ссылка |
| `largeText` | `''` | Тултип картинки; пусто — встроенная сводка |
| `showButton` | `false` | Кнопка «Open DSH» со ссылкой на веб-интерфейс (`DSH_WEB_URL`) |
| `webhookUrl` | `''` | Вебхук канала Discord: один embed на завершённый ход |
| `webhookOnTurnEnd` | `true` | Постить вебхук на `turn/end` |
| `webhookOnSessionStart` | `false` | Постить вебхук на старте сессии |
| `statusFile` | `true` | Писать `status.json` |
| `statusFilePath` | `''` | Свой путь; пусто — `<DSH_HOME>/discord-presence/status.json` |
| `minUpdateIntervalMs` | `15000` | Минимум между обновлениями карточки (Discord принимает ~5 за 20 с); `0` снимает троттлинг |
| `tickIntervalMs` | `30000` | Как часто обновлять карточку и файл, когда ничего не происходит (минимум 5000) |

### Плейсхолдеры шаблонов

`{project}` `{workspace}` `{model}` `{provider}` `{tokens}` `{tokensIn}`
`{tokensOut}` `{turns}` `{steps}` `{tools}` `{session}` `{agent}` `{status}` `{elapsed}`
`{uptime}` `{sessions}` `{subagents}` `{discord}`

`{session}` — последние 8 символов id, `{tokens}` — сокращённо (`1.2M`, `17k`).
Пустые куски вместе с разделителями `·` выбрасываются, так что шаблон не оставляет
висящих точек. Discord режет строку на 128 символах — плагин обрезает сам.

---

## Статус-файл

По умолчанию: `<DSH_HOME>\discord-presence\status.json` (для Windows-профиля это, например,
`C:\Users\<ты>\.dsh\discord-presence\status.json`). Пишется атомарно (tmp + rename), не чаще
раза в секунду, и никогда не роняет плагин при ошибке записи.

```jsonc
{
  "plugin": "dsh-discord-presence",
  "version": "1.0.0",
  "updatedAt": "2026-09-30T17:42:49.377Z",
  "harness": { "pid": 15508, "uptimeMs": 33981, "uptime": "33s" },
  "discord": { "enabled": true, "clientId": "missing", "state": "unconfigured", "ready": false },
  "activity": { "details": "default-workspace", "state": "waiting for a task" },
  "sessions": { "live": 1, "subagents": 0, "active": "session-…", "all": [ /* по сессии */ ] },
  "project": { "name": "default-workspace", "cwd": "C:\\…", "agentPreset": "standard" },
  "usage": { "total": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "source": "fold" },
  "counts": { "turns": 0, "steps": 0, "tools": 0, "retries": 0, "interruptions": 0 },
  "webhook": { "configured": false, "sent": 0, "skipped": 0 },
  "diagnostics": [ /* последние 40 строк журнала плагина */ ]
}
```

Файл удобно цеплять к OBS, Stream Deck, своим скриптам или второму плагину — например,
рисовать оверлей «сколько токенов сожрано за стрим». URL вебхука в файл не попадает:
остаётся только хост, путь редактируется.

---

## Файлы

| Файл | Что внутри |
| --- | --- |
| `index.js` | cordis-плагин: схема настроек, подписка на события сессий, сборка карточки, статус-файл, вебхук |
| `lib/discord-ipc.js` | транспорт: поиск пайпа `discord-ipc-0..9`, фрейминг `opcode|length|json`, handshake, переподключение, троттлинг |
| `lib/session-tracker.js` | чистый фолд событий в счётчики: токены, ходы, инструменты, выбор активной сессии |
| `lib/presence.js` | рендер карточки: строки, шаблоны, склонения, формат длительности и токенов |
| `lib/status-file.js` | атомарная запись `status.json` |
| `lib/webhook.js` | постинг embed-ов с троттлингом |
| `cordis.patch.yml` | строка, которую bundle вставляет в композицию профиля |
| `test/` | тесты (см. ниже) |

---

## Тесты

```powershell
cd <путь к плагину>
node test/presence.test.mjs   # 23 — рендер, склонения, шаблоны, тумблеры
node test/ipc.test.mjs        # 12 — фрейминг, handshake, CLOSE, переподключение
node test/plugin.test.mjs     # 13 — плагин целиком: mock-Discord + локальный HTTP-приёмник
```

Все три набора самодостаточны: поднимают свой именованный пайп и свой HTTP-сервер, наружу
не ходят, после себя всё закрывают (процесс завершается сам, без `--test-force-exit`).

Отдельно есть живая проверка транспорта против настоящего Discord:

```powershell
node test/probe-live-discord.mjs <ApplicationID>
```

Скрипт подключается к реальному пайпу, проходит handshake и ставит карточку, потом снимает.
С фейковым id Discord ответит `CLOSE 4000 Invalid Client ID` — это тоже полезный результат.

---

## Установка и удаление

Из GitHub (репозиторий публичный):

```powershell
dsh plugin --profile web add github:nightfun-pixel/dsh-discord-presence
```

Локальная разработка — link-зависимость на клон репозитория:

```powershell
dsh plugin --profile web add "link:D:/path/to/dsh-discord-presence"
```

`dsh` здесь — это `node '<DSH_HOME>\..\app\node_modules\@deepseek-ai\dsh\lib\bin.js'`;
подкоманда `plugin` просто проксирует pnpm в каталог профиля. Команда сама добавляет пакет
в `dependencies` и в `dsh.profile.bundles` профиля
`<DSH_HOME>\profiles\<профиль>\package.json` и делает junction в `node_modules\`.
Правки в файлах link-зависимости подхватываются без переустановки — нужен только
перезапуск харнеса.

Убрать:

```powershell
dsh plugin --profile web remove dsh-discord-presence
```

---

## Если что-то не работает

| Симптом | Причина и что делать |
| --- | --- |
| `discord.state: "unconfigured"` | Не задан `clientId`. Заполни и перезапусти харнес. |
| `discord.state: "invalid-client-id"` | Discord ответил `CLOSE 4000` — опечатка в Application ID. Плагин намеренно не переподключается в цикле; исправь id (правка подхватится на лету). |
| `discord.state: "offline"` | Discord не запущен или пайп не найден. Проверь `\\.\pipe\discord-ipc-0` (Windows). Плагин сам переподключится, когда клиент появится. |
| Карточка есть, но пустая | У сессии ещё не было хода: показывается `waiting for a task`. |
| Карточки нет, а в логе `connected` | Discord показывает активность только для desktop-клиента и только если у приложения есть хотя бы одна активность; подожди 15 с троттлинга. |
| Харнес не видит плагин | Строка не попала в `dsh.profile.bundles` или харнес не перезапускался. Проверь `--dump-config`: |

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'discord-presence' -Context 0,10
```

Журнал плагина — в `status.json` (`diagnostics`) и в stderr харнеса строками
`[discord-presence] …`.

---

## Ограничения

* Rich Presence работает только с запущенным **desktop**-клиентом Discord.
* Discord принимает примерно 5 обновлений за 20 секунд — отсюда троттлинг по умолчанию
  15 с; счётчики от этого не страдают, они всё равно считаются по каждому событию.
* Плагин не подписывается на незнакомые события: неизвестный тип события игнорируется,
  а не роняет обработчик (в `diagnostics` видно `lastEventType`).
* Никаких сетевых запросов, кроме опционального вебхука. Application ID — публичный
  идентификатор, не секрет; токенов и ключей плагин не читает.
