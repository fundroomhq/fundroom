---
"@fundroom/ai": minor
"@fundroom/ai-openai-compatible": minor
"@fundroom/ai-anthropic": minor
"@fundroom/module-updates": minor
"@fundroom/module-metrics": minor
"@fundroom/module-data-room": minor
"@fundroom/module-kit": minor
"@fundroom/domain": minor
"@fundroom/db": minor
"@fundroom/ports": minor
"@fundroom/config": minor
"@fundroom/contracts": minor
"@fundroom/audit": minor
"@fundroom/authz": minor
"@fundroom/portability": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

AI assist, opt-in. The operator configures one model provider (`AI_PROVIDER`:
`openai-compatible` for a self-hosted Ollama, vLLM or llama.cpp server or a hosted API, or
`anthropic`; default `none`), and each workspace turns on "Draft with AI" for investor updates and
"Suggest an answer" for data-room Q&A after acknowledging that provider. AI only produces
suggestions that staff apply through the normal editors; Q&A suggestions cite only pages the asker
(and the whole folder audience) can see, with server-verified quotes. New kernel package
`@fundroom/ai`, two adapters, core migration `0025_ai_assist`, routes under `/api/v1/ai`, per-user,
in-flight and monthly token budgets, and `/admin/settings/ai`.
