$inputJson = try { [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { $null }
$proj = 'this project'
if ($inputJson -and $inputJson.cwd) { $proj = Split-Path $inputJson.cwd -Leaf }
$date = Get-Date -Format 'yyyy-MM-dd'
# Opt-in: only inject the vault instruction when a vault path is configured (obsidianVault in the plugin config).
if (-not $env:DSH_OBSIDIAN_VAULT) { exit 0 }
$vault = $env:DSH_OBSIDIAN_VAULT
$ctx = "Session start: before other work, run the obsidian-vault skill's 'Open today's daily note' workflow in full for $date (today's note, related-topic search, past retro-Friday check); if no such skill is in your catalog, do it by hand in the vault at '$vault' (daily note path: Daily Notes/<YYYY-MM Month YYYY>/<YYYY-MM-DD>.md). Then resume scoped to this project only: first identify which single vault topic folder (vault folders are organised per project or topic) corresponds to '$proj', then grep ONLY inside that folder for '$proj' or the upcoming task. Do not grep the rest of the vault -- a project's search must never surface unrelated projects' notes. Only fall back to a vault-wide grep if no topic folder obviously matches this project. Surface any relevant existing note found. Skip silently if nothing matches."
$result = @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx } }
$result | ConvertTo-Json -Compress -Depth 5
