# Розробка та перевірки

## Середовище

Використовуйте Node.js 22.22.1, як у тестовому workflow, та `npm ci` для встановлення за lockfile. Tests і Pages читають спільну версію з `.nvmrc`; локально її можна вибрати через `nvm use`. Для папок потрібен File System Access, для відео — підтримка WebCodecs; доступність функцій перевіряйте в реальному цільовому браузері.

| Команда | Результат |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | TypeScript і production-збірка в `dist/` |
| `npm run preview` | Перегляд зібраного застосунку |
| `npm test` | Усі тринадцять офлайн-наборів, зупинка після першої помилки |
| `npm run lint` | ESLint 9 (flat config `eslint.config.js`), без попереджень |
| `npm run test:ci` | По черзі: lint, перевірка документації, усі тести, build, браузерні сценарії |
| `npm run test:docs` | Тест валідатора та перевірка посилань, шляхів і npm-команд у документації |
| `npm run test:browser-fixtures` | Збірка стендів із `vite.browser.config.ts` у `dist/browser-fixtures/` |
| `npm run test:browser` | Збірка стендів і `playwright test` (Chromium) над `vite preview` на `127.0.0.1:4174` за `tests/e2e/*.spec.ts`; порт змінює `PW_PORT` (наприклад `PW_PORT=4175 npm run test:browser`), щоб паралельні checkout-и або worktrees не конфліктували |
| `npm run test:caption-txt` | TXT як єдине джерело підпису: формат, trigger word, переміщення через межу `dataset/`, міграція sidecar-тегів |
| `npm run test:character-traits` | Риси персонажа: групи тегів, правила Always tag / Leave to trigger, збереження в `project.json`, виключення з постійних тегів |
| `npm run test:browser:network` | Лише сценарії з тегом `@network`, один воркер |
| `npx playwright test --grep @slow` | Тривалі сценарії (one-hour video) |

Перед першим локальним запуском браузерних сценаріїв виконайте `npx playwright install chromium`. Lint входить у `test:ci` першим кроком; успішний build не замінює lint. У `eslint.config.js` свідомо вимкнено або приглушено з обґрунтуванням: `react-hooks/exhaustive-deps` (зміна залежностей змінила б поведінку ефектів), `no-explicit-any`, `no-empty-object-type`, `no-control-regex` (санітайзери імен); дозволено `_`-префікс невикористаних імен і порожні `catch`. Попередження ONNX про `eval` і великі chunks можуть з’являтися під час збірки; їх потрібно відрізняти від коду завершення з помилкою.

## Вибір регресійних перевірок

| Зона зміни | Команда |
| --- | --- |
| Серіалізація, формат v3, міграція layout (знімок, журнал, resume), реєстр ресурсів і rebind, експорт, індексація, Explorer, Dataset-файли, версії | `npm run test:project-types` |
| TXT-підписи, trigger word, пакетний перезапис, sidecar → TXT | `npm run test:caption-txt` |
| Риси персонажа й правила тегера | `npm run test:character-traits` |
| Вибір кадрів, індекс, скасування, fingerprints, запис PNG | `npm run test:video-frames` |
| Команди, підписи, імпорт/експорт, save queue, навігація | `npm run test:ui-workflows` |
| Кандидати, coverage, Assemble, статуси кадрів і міграція сесії v1 → v2, міграція підписів | `npm run test:dataset-assembly` |
| Прев’ю, blob URL, snapshots, дозволи, збереження й відновлення локального тегера, класифікація файлів | `npm run test:service-boundaries` |
| Відновлення після помилок, concurrent saves, історія та операції | `npm run test:state-recovery` |
| Рівні схожості DINOv2, Strictness, пороги, кластеризація | `npm run test:similarity` (групування за темами на Board — `tests/e2e/next-grid.spec.ts` і `next-assemble.spec.ts` у `npm run test:browser`) |
| Перевірене завантаження моделей (розмір, SHA-256, DINOv2, WD-тегер) | `npm run test:model-download` |
| Папки inbox і Sources | `npm run test:inbox-folders` (дерево папок inbox, вибір джерел, лічильники; замінює колишній `auto-select`) |
| Тегер у воркері: перевірка моделі, відкат WebGPU, помилки пам’яті | `npm run test:tagger-worker` |
| Метрики звіту якості Dataset (пороги, Vendi, покриття, готовність) | `npm run test:quality-metrics` |

Тематичні регресійні скрипти в `tests/*.mjs` збирають потрібні TypeScript-модулі через Rolldown у тимчасову папку, виконують перевірки й прибирають bundle. Вони використовують справжню логіку застосунку з in-memory filesystem або симуляціями браузерних API. Нові тести для сервісів і стану використовують `node:test`; запускати їх можна через відповідні npm-команди.

Для нової регресії оберіть наявний тематичний набір. Перевіряйте видимий результат, порядок операцій, помилку або збережені дані. Для конкурентності використовуйте керовані promises, для timeout — контрольовані таймери; не прив’язуйте тест до випадкової швидкості машини. Не додавайте аналогічний helper або ще одну бібліотеку тестування без потреби.

## Межі автоматизації

Браузерні сценарії запускає Playwright (Chromium) над `vite preview`; конфігурація — `playwright.config.ts`, специфікації — `tests/e2e/`. Стенди збираються з `vite.browser.config.ts` у `dist/browser-fixtures/`:

| Стенд | Що перевіряє |
| --- | --- |
| `next` (`next-browser.html`) | Єдиний інтерфейс: екрани Projects і Board (`tests/e2e/next-*.spec.ts`: проєкт, Sources, сітка, lightbox, Assemble, членство, Health, Caption, Export включно з офлайн-PSD, файли, налаштування, оверлеї, перемикання проєктів, застарілі ключі localStorage, проєкт v1) |
| `persistence` | Збереження проєкту після перезавантаження, відновлення версії, регресії фізичного членства Dataset (`dataset-folder-checks.tsx`) |
| `caption-editor` | Редактор підписів |
| `video` | Video Frames: VFR/повернуті відео, кеш, збереження кадрів |
| `tagger-restore`, `tagger-download` | Збереження/відновлення файлів тегера; завантаження WD-тегера на mock-відповіді |
| `semantic-cache` | Постійний кеш ознак зображень |

Збирання йде з `react-dom/profiling`, щоб `<Profiler>` рахував рендери. Спільна guard-fixture (`tests/e2e/fixtures.ts`) провалює тест на `pageerror`, `console.error` і зовнішні запити; виняток — корінь iframe Photopea, який монтує застосунок. Допоміжні кроки Board для специфікацій — `tests/e2e/nextFlow.ts`. На слабких машинах запускайте Playwright з меншою кількістю воркерів, наприклад `npx playwright test --workers=2`, а збирання й браузерний прогін — лише послідовно: паралельно вони можуть вичерпати пам’ять.

Поза типовим прогоном лишаються сценарії з тегами `@network` (живий експорт Photopea, справжня DINOv2 з Hugging Face; можливе звіряння маніфесту WD-тегера з Hugging Face; потребують мережі) і `@slow` (one-hour video; тривалі). Сценарій `tests/e2e/tagger-download.spec.ts` перевіряє завантаження WD-тегера на mock-відповіді, без мережі. Стенд tagger-restore перевіряє збереження назв і байтів копій `File` в IndexedDB після перезавантаження; він не запускає модель і не перевіряє повторний запит дозволу до native handle.

Окремо перевіряйте native file picker, відновлення збережених ONNX/CSV після перезавантаження та повторний дозвіл браузера, живий Photopea, фактичний ONNX inference, клавіатуру, фокус, zoom та доступність. Сценарії `@network` залежать від мережі, частина відеоперевірок завантажує модель і залежить від GPU/кодеків. [Історичний UI-звіт](../tests/ui-validation.md) містить відтворювані сценарії та їхні обмеження. Наявні тести не дають виміряного відсотка покриття всього коду.

## Робота зі зміною

1. Перегляньте `git status` і [карту коду](code-map.md). Визначте власника потрібної поведінки.
2. Прочитайте цільовий модуль і відповідний тест; перевірте наявні call sites функції.
3. Змініть одну спільну реалізацію, зберігши правила шляхів, Dataset, підписів і черги збереження.
4. Запустіть відповідний набір; для зміни типів або UI — також build. Перед передачею значних змін використайте `npm run test:ci`.
5. Оновіть основний документ теми. Не включайте `plan.md` та чужі незавершені зміни у свій коміт.

CI в `.github/workflows/tests.yml` запускає `npm run test:ci` на push і pull request. Pages викликає той самий workflow через `workflow_call`; build починається лише після успіху tests, deploy — після build. Подробиці — в [розгортанні](../DEPLOYMENT.md).

## Перевірка документації та локальні файли

`scripts/check-docs.mjs` перевіряє README, ARCHITECTURE, DEPLOYMENT, AGENTS та всі Markdown-файли в `docs/`, включно з підпапками. Перевіряються локальні inline/reference-посилання (наявність файлу, без anchors), явні шляхи `src/` до TS/TSX/CSS у backticks і назви `npm run` команд. Зовнішні URL не запитуються; історичні звіти й приватні плани не скануються. Це перевірка посилань і команд, а не повний Markdown-парсер чи перевірка змісту документації.

`.gitignore` виключає кореневий `plan.md`, `tmp/`, кеші, результати тестів, coverage, тимчасові файли та локальні `.env.*`. Шаблони `.env.example` і `.env.*.example` залишаються доступними для комітів. AGENTS і документація залишаються під контролем версій. Ігнорування не діє на вже відстежувані файли; перед комітом усе одно перевіряйте staged diff і додавайте файли явно.

Redux DevTools для store проєкту вимкнено за замовчуванням, бо розширення серіалізує весь багатомегабайтний стан на кожну зміну й гальмує Build. Щоб увімкнути для налагодження, запустіть dev-сервер із `VITE_STORE_DEVTOOLS=1`.
