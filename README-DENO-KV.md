# Black Helper — Deno KV

Проект переведён с Upstash Redis на встроенный Deno KV.

Что изменено:
- `kv.ts`: полностью убран `@upstash/redis` и переменные `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
- Все остальные файлы продолжают использовать привычный `redis.get/set/del/...` интерфейс через совместимый адаптер.
- Redis Sets реализованы отдельными Deno KV-ключами с prefix.
- Redis Lists реализованы как массивы в Deno KV.
- `incr` использует атомарную операцию Deno KV.
- `keys("b2:*")` поддержан для `/resetdata`.

Что нужно на Deno Deploy:
- VK_TOKEN оставить как есть.
- Upstash env-переменные удалить: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Deno KV должен быть включён/доступен для проекта Deploy.

Важно:
- Старые данные из Upstash автоматически не переносятся. Если в Upstash уже есть важные данные, их нужно отдельно мигрировать.
- Адаптер сохраняет текущую структуру приложения, поэтому `main.ts`, `moderation.ts`, `nicknames.ts`, `roles.ts`, `servers.ts`, `setup.ts` и `activity.ts` не требуют переписывания.
