@AGENTS.md
## Claude Code
You have access to Swiggy Builders Club docs - the authoritative source
for Swiggy MCP (Food, Instamart, Dineout). Always consult these before
writing Swiggy code:
 
- Index:      https://mcp.swiggy.com/builders/llms.txt
- Full text:  https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:   append `.md` to any https://mcp.swiggy.com/builders/docs/... URL
 
Tool schemas live under `/docs/reference/{food,instamart,dineout}`.
Error codes live at `/docs/reference/errors`. Auth flow is at
`/docs/start/authenticate`.
 
Rules:
1. Before recommending a tool name, parameter, error code, rate limit,
   or auth flow, fetch the relevant doc and verify.
2. Never invent tool names or parameters. If the docs don't cover it,
   say so and ask.
3. Prefer `.md` page fetches over `llms-full.txt` when you know the
   exact area - it's cheaper on context.
## Swiggy Builders Club
 
When writing code against Swiggy MCP (Food, Instamart, Dineout),
consult the authoritative docs at:
 
- Index:     https://mcp.swiggy.com/builders/llms.txt
- Full text: https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:  append `.md` to any https://mcp.swiggy.com/builders/docs/... URL
 
Before recommending a tool name, parameter, error code, rate limit, or
auth flow, verify against these docs. The tool catalog lives under
`/docs/reference/{food,instamart,dineout}`.