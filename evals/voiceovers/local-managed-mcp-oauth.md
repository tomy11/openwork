# Local managed MCP OAuth

1. “I add a remote MCP from Extensions and choose OpenWork-managed sign-in.
   OpenWork explains that it will handle authorization and token refresh while
   the agent continues to use the provider's normal tools.”

2. “For a provider such as BigQuery, I enter the registered OAuth client and
   requested scopes once. The provider secret is not written into my workspace
   or OpenCode configuration.”

3. “I select Connect. OpenWork opens the provider authorization page, receives
   the loopback callback, and reports Connected only after an authenticated
   tool catalog can be read.”

4. “I start a task in the same workspace. The bundled OpenCode engine sees the
   provider's tools through OpenWork's local MCP endpoint and invokes one
   successfully without receiving the provider access or refresh token.”

5. “After OpenWork restarts, the local gateway is registered again and the
   connection remains usable. If the provider revokes access, the connection
   changes to Reconnect required instead of claiming that transport access is
   authenticated.”

6. “When I disconnect, OpenWork deletes its credential and removes the local
   gateway from the engine, so the tools are no longer available.”
