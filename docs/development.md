# Розробка та перевірки

## Середовище

Використовуйте Node.js 22.22.1, як у тестовому workflow, та `npm ci` для встановлення за lockfile. Tests і Pages читають спільну версію з `.nvmrc`; локально її можна вибрати через `nvm use`. Для папок потрібен File System Access, для відео — підтримка WebCodecs; доступність функцій перевіряйте в реальному цільовому браузері.

| Команда | Результат |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | TypeScript і production-збірка в `dist/` |
| `npm run preview` | Перегляд зібраного застосунку |
| `npm test` | Усі дев’ять офлайн-наборів, зупинка після першої помилки |
| `npm run lint` | ESLint 9 (flat config `eslint.config.js`), без попереджень |
| `npm run test:ci` | По черзі: lint, перевірка документації, усі тести, build, браузерні сценарії |
| `npm run test:docs` | Тест валідатора та перевірка посилань, шляхів і npm-команд у документації |
| `npm run test:browser-fixtures` | Збірка стендів із `vite.browser.config.ts` у `dist/browser-fixtures/` |
| `npm run test:browser` | Збірка стендів і `playwright test` (Chromium) над `vite preview` на `127.0.0.1:4174` за `tests/e2e/*.spec.ts` |
| `npm run test:browser:network` | Лише сценарії з тегом `@network`, один воркер |
| `npx playwright test --grep @slow` | Тривалі сценарії (one-hour video) |

Перед першим локальним запуском браузерних сценаріїв виконайте `npx playwright install chromium`. Lint входить у `test:ci` першим кроком; успішний build не замінює lint. У `eslint.config.js` свідомо вимкнено або приглушено з обґрунтуванням: `react-hooks/exhaustive-deps` (зміна залежностей змінила б поведінку ефектів), `no-explicit-any`, `no-empty-object-type`, `no-control-regex` (санітайзери імен); дозволено `_`-префікс невикористаних імен і порожні `catch`. Попередження ONNX про `eval` і великі chunks можуть з’являтися під час збірки; їх потрібно відрізняти від коду завершення з помилкою.

## Вибір регресійних перевірок

| Зона зміни | Команда |
| --- | --- |
| Серіалізація, міграції, індексація, Explorer, Dataset-файли, версії | `npm run test:project-types` |
| Docking, геометрія, вкладки й відновлення layout | `npm run test:workspace-layout` |
| Вибір кадрів, індекс, скасування, fingerprints, запис PNG | `npm run test:video-frames` |
| Команди, підписи, імпорт/експорт, save queue, навігація | `npm run test:ui-workflows` |
| Кандидати, coverage, формування Dataset, міграція підписів | `npm run test:dataset-assembly` |
| Прев’ю, blob URL, snapshots, дозволи, збереження й відновлення локального тегера, класифікація файлів | `npm run test:service-boundaries` |
| Відновлення після помилок, concurrent saves, історія та операції | `npm run test:state-recovery` |
| Рівні схожості DINOv2, Strictness, пороги, кластеризація Build | `npm run test:similarity` (потік перегляду кластерів — `tests/e2e/build-clusters.spec.ts` у `npm run test:browser`) |
| Метрики звіту якості Dataset (пороги, Vendi, покриття, готовність) | `npm run test:quality-metrics` |

Тематичні регресійні скрипти в `tests/*.mjs` збирають потрібні TypeScript-модулі через Rolldown у тимчасову папку, виконують перевірки й прибирають bundle. Вони використовують справжню логіку застосунку з in-memory filesystem або симуляціями браузерних API. Нові тести для сервісів і стану використовують `node:test`; запускати їх можна через відповідні npm-команди.

Для нової регресії оберіть наявний тематичний набір. Перевіряйте видимий результат, порядок операцій, помилку або збережені дані. Для конкурентності використовуйте керовані promises, для timeout — контрольовані таймери; не прив’язуйте тест до випадкової швидкості машини. Не додавайте аналогічний helper або ще одну бібліотеку тестування без потреби.

## Межі автоматизації

Браузерні сценарії запускає Playwright (Chromium) над `vite preview`; конфігурація — `playwright.config.ts`, специфікації — `tests/e2e/`. Стенди збираються з `vite.browser.config.ts` (explorer, export, persistence, caption, caption-editor, build, inspector, project-switch, tagger-restore, scope, ui, video) із `react-dom/profiling`, щоб `<Profiler>` рахував рендери. Специфікація `tests/e2e/explorer-mutations.spec.ts` покриває rename, нову папку, copy/paste, duplicate, delete і клавіатуру Explorer. Спільна guard-fixture (`tests/e2e/fixtures.ts`) провалює тест на `pageerror`, `console.error` і зовнішні запити; виняток — корінь iframe Photopea, який монтує App.

Поза типовим прогоном лишаються сценарії з тегами `@network` (живий експорт Photopea, справжня DINOv2 з Hugging Face; потребують мережі) і `@slow` (one-hour video; тривалі). Стенди document (iframe Photopea) і workspace (потрібен dev server застосунку) пропущені з поясненням у `tests/e2e/skipped.spec.ts`. Стенд tagger-restore перевіряє збереження назв і байтів копій `File` в IndexedDB після перезавантаження; він не запускає модель і не перевіряє повторний запит дозволу до native handle. Export і caption стенди працюють із фізичним членством у `dataset/`.

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
