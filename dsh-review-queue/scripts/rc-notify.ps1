# Posts one message to the user's own RingCentral chat. Called by ai-report-notify.js with the env file path; the message arrives on stdin as {"text": "..."}.
# The env file holds RC_CLIENT_ID, RC_CLIENT_SECRET, RC_SERVER, RC_JWT, RC_PERSONAL_CHAT_ID. Secrets are never printed: every failure is one fixed line and exit 1.
param([Parameter(Mandatory = $true)][string]$EnvFile)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail([string]$Message) { [Console]::Error.WriteLine('rc-notify: ' + $Message); exit 1 }
function StatusOf($err) { try { return [int]$err.Exception.Response.StatusCode } catch { return 0 } }

# Stdin as raw bytes decoded as UTF-8, so the console code page cannot garble the text.
$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
try { $text = [string](([System.Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json).text) } catch { Fail 'the message on stdin is not valid JSON' }
if ([string]::IsNullOrWhiteSpace($text)) { Fail 'the message is empty' }

$cfg = @{}
try {
	foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
		if ($line -match '^\s*(RC_[A-Z_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim('"', "'") }
	}
} catch { Fail 'the env file cannot be read' }
foreach ($key in 'RC_CLIENT_ID', 'RC_CLIENT_SECRET', 'RC_SERVER', 'RC_JWT', 'RC_PERSONAL_CHAT_ID') {
	if (-not $cfg[$key]) { Fail ('the env file has no ' + $key) }
}
# Secrets (client secret, JWT) go in the token request: refuse a plain-http or malformed server before anything is sent.
if ($cfg['RC_SERVER'] -notmatch '^https://') { Fail 'RC_SERVER must be an https:// URL' }
$server = $cfg['RC_SERVER'].TrimEnd('/')

# JWT-bearer token exchange, client credentials as Basic auth.
$basic = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($cfg['RC_CLIENT_ID'] + ':' + $cfg['RC_CLIENT_SECRET']))
try {
	$auth = Invoke-RestMethod -Method Post -Uri ($server + '/restapi/oauth/token') -TimeoutSec 15 -Headers @{ Authorization = 'Basic ' + $basic } `
		-ContentType 'application/x-www-form-urlencoded' -Body @{ grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer'; assertion = $cfg['RC_JWT'] }
} catch { Fail ('the sign-in request failed (HTTP ' + (StatusOf $_) + ')') }
if (-not $auth.access_token) { Fail 'the sign-in answer had no access token' }

# The post body is sent as UTF-8 bytes so accents and dashes survive.
$body = [System.Text.Encoding]::UTF8.GetBytes((@{ text = $text } | ConvertTo-Json -Compress))
try {
	Invoke-RestMethod -Method Post -Uri ($server + '/team-messaging/v1/chats/' + [Uri]::EscapeDataString($cfg['RC_PERSONAL_CHAT_ID']) + '/posts') -TimeoutSec 15 `
		-Headers @{ Authorization = 'Bearer ' + $auth.access_token } -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
} catch { Fail ('the post request failed (HTTP ' + (StatusOf $_) + ')') }
exit 0
