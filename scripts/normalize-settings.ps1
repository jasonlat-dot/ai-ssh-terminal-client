# ============================================================================
# normalize-settings.ps1 — bring BackendSettingsDialog.css onto the shared
# type scale and the single radius scale defined in styles/tokens.css.
#
# Before: 12 font sizes (9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15)
#         11 border radii (0, 2, 4, 5, 6, 7, 8, 9, 10, 12, 999)
# After:  7 type steps and 4 radii, all named tokens.
# ============================================================================

$path = Join-Path $PSScriptRoot '..\src\components\BackendSettingsDialog.css'
$css = Get-Content $path -Raw

# Font size -> type token. Snaps each existing value to the nearest step so
# the relative hierarchy the sheet already encodes is preserved.
$type = [ordered]@{
  'font-size:\s*9px'    = 'font-size: var(--t-micro)';
  'font-size:\s*9\.5px'  = 'font-size: var(--t-micro)';
  'font-size:\s*10px'   = 'font-size: var(--t-micro)';
  'font-size:\s*10\.5px(\s*!important)?' = 'font-size: var(--t-xs)';
  'font-size:\s*11px'   = 'font-size: var(--t-xs)';
  'font-size:\s*11\.5px' = 'font-size: var(--t-sm)';
  'font-size:\s*12px'   = 'font-size: var(--t-sm)';
  'font-size:\s*12\.5px' = 'font-size: var(--t-md)';
  'font-size:\s*13px'   = 'font-size: var(--t-md)';
  'font-size:\s*13\.5px' = 'font-size: var(--t-lg)';
  'font-size:\s*14px'   = 'font-size: var(--t-lg)';
  'font-size:\s*15px'   = 'font-size: var(--t-xl)';
}

foreach ($entry in $type.GetEnumerator()) {
  $css = [regex]::Replace($css, $entry.Key, $entry.Value)
}

# Border radius -> radius token, honouring the documented rule:
# small controls, medium surfaces, large overlays, pills.
$radius = [ordered]@{
  'border-radius:\s*2px'  = 'border-radius: var(--r-sm)';
  'border-radius:\s*3px'  = 'border-radius: var(--r-sm)';
  'border-radius:\s*4px'  = 'border-radius: var(--r-sm)';
  'border-radius:\s*5px'  = 'border-radius: var(--r-sm)';
  'border-radius:\s*6px'  = 'border-radius: var(--r-sm)';
  'border-radius:\s*7px'  = 'border-radius: var(--r-sm)';
  'border-radius:\s*8px'  = 'border-radius: var(--r-md)';
  'border-radius:\s*9px'  = 'border-radius: var(--r-md)';
  'border-radius:\s*10px' = 'border-radius: var(--r-md)';
  'border-radius:\s*12px' = 'border-radius: var(--r-lg)';
  'border-radius:\s*14px' = 'border-radius: var(--r-lg)';
  'border-radius:\s*16px' = 'border-radius: var(--r-lg)';
  'border-radius:\s*999px' = 'border-radius: var(--r-full)';
  'border-radius:\s*50%'  = 'border-radius: var(--r-full)';
}

foreach ($entry in $radius.GetEnumerator()) {
  $css = [regex]::Replace($css, $entry.Key, $entry.Value)
}

# The three stacked values collapse to one literal.
$css = [regex]::Replace($css, 'border-radius:\s*var\(--r-sm\) var\(--r-sm\) var\(--r-sm\) var\(--r-sm\)', 'border-radius: var(--r-sm)')

Set-Content -Path $path -Value $css -NoNewline

$out = Get-Content $path -Raw
$remainingSizes = ([regex]::Matches($out, 'font-size:\s*[0-9.]+px')).Count
$remainingRadii = ([regex]::Matches($out, 'border-radius:\s*[0-9a-z%]+(?!\s*var)')).Count
Write-Output "Settings normalized. Remaining raw font-size literals: $remainingSizes, remaining raw border-radius literals: $remainingRadii"
