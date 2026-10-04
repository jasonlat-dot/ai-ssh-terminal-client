# ============================================================================
# normalize-components.ps1 — bring the remaining component stylesheets onto
# the shared type scale, the single radius scale, and the token palette.
#
# Target sheets: SftpFileManager.css, TerminalWelcome.css, DisconnectDialog.css,
#                FileUploadDialog.css, ChatAttachments.css, CopyTextButton.css
#
# These sheets were written before tokens.css existed, so each carries its own
# private font/radius/colour vocabulary. Normalising them is what makes the
# product read as one designed system rather than a set of related screens.
# ============================================================================

$sheets = @(
  'SftpFileManager.css',
  'TerminalWelcome.css',
  'DisconnectDialog.css',
  'FileUploadDialog.css',
  'ChatAttachments.css',
  'CopyTextButton.css'
)

# --- shared scales ----------------------------------------------------------

$type = [ordered]@{
  'font-size:\s*9px'     = 'font-size: var(--t-micro)';
  'font-size:\s*9\.5px'  = 'font-size: var(--t-micro)';
  'font-size:\s*10px'    = 'font-size: var(--t-micro)';
  'font-size:\s*10\.5px' = 'font-size: var(--t-xs)';
  'font-size:\s*11px'    = 'font-size: var(--t-xs)';
  'font-size:\s*11\.5px' = 'font-size: var(--t-sm)';
  'font-size:\s*12px'    = 'font-size: var(--t-sm)';
  'font-size:\s*12\.5px' = 'font-size: var(--t-md)';
  'font-size:\s*13px'    = 'font-size: var(--t-md)';
  'font-size:\s*13\.5px' = 'font-size: var(--t-lg)';
  'font-size:\s*14px'    = 'font-size: var(--t-lg)';
  'font-size:\s*15px'    = 'font-size: var(--t-lg)';
  'font-size:\s*16px'    = 'font-size: var(--t-xl)';
}

$radius = [ordered]@{
  'border-radius:\s*2px'   = 'border-radius: var(--r-sm)';
  'border-radius:\s*3px'   = 'border-radius: var(--r-sm)';
  'border-radius:\s*4px'   = 'border-radius: var(--r-sm)';
  'border-radius:\s*5px'   = 'border-radius: var(--r-sm)';
  'border-radius:\s*6px'   = 'border-radius: var(--r-sm)';
  'border-radius:\s*7px'   = 'border-radius: var(--r-sm)';
  'border-radius:\s*8px'   = 'border-radius: var(--r-md)';
  'border-radius:\s*9px'   = 'border-radius: var(--r-md)';
  'border-radius:\s*10px'  = 'border-radius: var(--r-md)';
  'border-radius:\s*12px'  = 'border-radius: var(--r-lg)';
  'border-radius:\s*14px'  = 'border-radius: var(--r-lg)';
  'border-radius:\s*16px'  = 'border-radius: var(--r-lg)';
  'border-radius:\s*999px' = 'border-radius: var(--r-full)';
  'border-radius:\s*50%'   = 'border-radius: var(--r-full)';
  'border-radius:\s*0 0 14px 14px' = 'border-radius: 0 0 var(--r-lg) var(--r-lg)';
  'border-radius:\s*0 0 10px 10px' = 'border-radius: 0 0 var(--r-md) var(--r-md)';
}

# --- colour: semantic families --------------------------------------------

$colour = [ordered]@{
  # danger family
  '#b94740'   = 'var(--danger)';  '#a4433d' = 'var(--danger)';
  '#c44c44'   = 'var(--danger)';  '#a83b35' = 'var(--danger)';
  '#c34c42'   = 'var(--danger)';  '#b6423b' = 'var(--danger)';
  '#df5b52'   = 'var(--danger)';  '#c45149' = 'var(--danger)';
  '#d35d55'   = 'var(--danger)';  '#b23f38' = 'var(--danger)';
  # warn family
  '#8a5a0d'   = 'var(--warn)';    '#c98a22' = 'var(--warn)';
  '#d99b32'   = 'var(--warn)';    '#a67626' = 'var(--warn)';
  # success
  '#075f4b'   = 'var(--accent-active)';
  # shadows / scrims
  '#18243966' = 'var(--theme-shadow)';
  '#15263f70' = 'var(--theme-shadow)';
  '#152c4b38' = 'var(--theme-shadow)';
  '#17263d38' = 'var(--theme-shadow)';
  '#142c4a2b' = 'var(--shadow-md)';
  '#1227432b' = 'var(--shadow-md)';
  '#132a4933' = 'var(--shadow-sm)';
  '#10233c4a' = 'var(--shadow-md)';
  '#17375f14' = 'var(--shadow-sm)';
  '#fff'      = 'var(--accent-ink)';
  '#ffffff'   = 'var(--accent-ink)';
}

foreach ($sheet in $sheets) {
  $path = Join-Path $PSScriptRoot "..\src\components\$sheet"
  if (-not (Test-Path $path)) { Write-Output "skip (missing): $sheet"; continue }
  $css = Get-Content $path -Raw
  $before = $css

  foreach ($e in $type.GetEnumerator())   { $css = [regex]::Replace($css, $e.Key, $e.Value) }
  foreach ($e in $radius.GetEnumerator()) { $css = [regex]::Replace($css, $e.Key, $e.Value) }
  foreach ($e in $colour.GetEnumerator()) { $css = [regex]::Replace($css, "(?i)(?<![0-9a-f])$([regex]::Escape($e.Key))(?![0-9a-f])", $e.Value) }

  # Collapse radii the rewrite may have expanded to a repeated token.
  $css = [regex]::Replace($css, 'border-radius:\s*var\(--r-sm\) var\(--r-sm\) var\(--r-sm\) var\(--r-sm\)', 'border-radius: var(--r-sm)')

  if ($css -ne $before) { Set-Content -Path $path -Value $css -NoNewline }

  $out = Get-Content $path -Raw
  $sizes = ([regex]::Matches($out, 'font-size:\s*[0-9.]+px')).Count
  $radii = ([regex]::Matches($out, 'border-radius:\s*([0-9]+px|[0-9]+%)')).Count
  $hexes = ([regex]::Matches($out, '#[0-9a-fA-F]{3,8}\b')).Count
  "{0,-30} rawSizes={1,-3} rawRadii={2,-3} rawHex={3}" -f $sheet, $sizes, $radii, $hexes
}
