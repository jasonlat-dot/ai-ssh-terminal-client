# ============================================================================
# remap-settings.ps1 — one-off migration of BackendSettingsDialog.css from the
# retired blue/mint palette onto the new token system.
#
# Every literal below was chosen by inspecting how the colour is actually used
# in that stylesheet (accent fill, accent text, accent border, success/warn/
# danger state, or a theme-specific surface). The result is that the settings
# surface no longer needs its 81 [data-theme='dark'] patches for colour.
# ============================================================================

$path = Join-Path $PSScriptRoot '..\src\components\BackendSettingsDialog.css'
$css = Get-Content $path -Raw

# Longest-first so 8-digit and 6-digit forms win over their 3-digit prefixes.
$map = [ordered]@{
  # --- accent (was #2675ff blue / #1aa179 mint) -------------------------
  '#2675ff33'  = 'var(--accent-glow)';
  '#2675ff22'  = 'var(--accent-glow)';
  '#2675ff1c'  = 'var(--accent-soft)';
  '#2675ff1a'  = 'var(--accent-soft)';
  '#2675ff00'  = 'var(--accent-soft)';
  '#2675ff'    = 'var(--accent)';
  '#5d8aff'    = 'var(--accent-hover)';
  '#1a64e6'    = 'var(--accent-active)';
  '#1aa17922'  = 'var(--ok-soft)';
  '#1aa179'    = 'var(--accent)';
  '#126d56'    = 'var(--accent-active)';
  '#2f8f6c'    = 'var(--ok)';
  '#1e5f9d'    = 'var(--accent-active)';
  '#1e6db8'    = 'var(--accent-active)';
  '#1769af'    = 'var(--accent-text)';
  '#4a82c2'    = 'var(--muted)';
  '#4a82c240'  = 'var(--surface-active)';
  '#4a82c200'  = 'var(--surface-active)';

  # --- accent as text on dark ------------------------------------------
  '#a8d0ff'    = 'var(--accent-text)';
  '#cfe1ff'    = 'var(--accent-text)';
  '#72a9e7'    = 'var(--accent-text)';
  '#6f96c8'    = 'var(--accent-text)';
  '#76a8e0'    = 'var(--accent-text)';
  '#8eaccb'    = 'var(--muted)';
  '#b9cbe4'    = 'var(--muted)';
  '#bfd5ee'    = 'var(--muted)';
  '#5d87b8'    = 'var(--muted)';
  '#6684a2'    = 'var(--muted)';
  '#6381a0'    = 'var(--muted)';
  '#4a607a'    = 'var(--muted)';

  # --- success ----------------------------------------------------------
  '#8fe0c5'    = 'var(--ok)';
  '#bfe5d8'    = 'var(--ok)';
  '#d6f0e1'    = 'var(--ok-soft)';
  '#dcf3e9'    = 'var(--ok-soft)';
  '#d9efe2'    = 'var(--ok-soft)';
  '#eaf8f2'    = 'var(--ok-soft)';
  '#eef9f4'    = 'var(--ok-soft)';
  '#effbf6'    = 'var(--ok-soft)';
  '#163527'    = 'var(--ok-soft)';
  '#18372f'    = 'var(--ok-soft)';
  '#285b4d'    = 'var(--ok)';
  '#112a23'    = 'var(--ok-soft)';

  # --- warning ----------------------------------------------------------
  '#8a5a0b'    = 'var(--warn)';
  '#975c0d'    = 'var(--warn)';
  '#d18b15'    = 'var(--warn)';
  '#d18b1522'  = 'var(--warn-soft)';
  '#efc676'    = 'var(--warn)';
  '#ebcf91'    = 'var(--warn)';
  '#fbecd0'    = 'var(--warn-soft)';
  '#fff1d6'    = 'var(--warn-soft)';
  '#fff5e0'    = 'var(--warn-soft)';
  '#fff7e5'    = 'var(--warn-soft)';
  '#302719'    = 'var(--warn-soft)';
  '#3a2c14'    = 'var(--warn-soft)';
  '#69542e'    = 'var(--warn)';

  # --- danger -----------------------------------------------------------
  '#c1483f'    = 'var(--danger)';
  '#c1483f22'  = 'var(--danger-soft)';
  '#d96e6e'    = 'var(--danger)';
  '#a33d3d'    = 'var(--danger)';
  '#ffb9b5'    = 'var(--danger)';
  '#f1c4c0'    = 'var(--danger)';
  '#fbd5d3'    = 'var(--danger)';
  '#fcdcd9'    = 'var(--danger)';
  '#fff0ef'    = 'var(--danger-soft)';
  '#704145'    = 'var(--danger)';
  '#3a2022'    = 'var(--danger-soft)';
  '#3a1f1e'    = 'var(--danger-soft)';
  '#2c181a'    = 'var(--danger-soft)';

  # --- neutral surfaces (dark side) -------------------------------------
  '#14253a'    = 'var(--terminal)';
  '#0e1a2a'    = 'var(--terminal)';
  '#1c3050'    = 'var(--surface-sunken)';
  '#2a456d'    = 'var(--surface-sunken)';
  '#1f3552'    = 'var(--surface-active)';
  '#14202f'    = 'var(--surface-sunken)';
  '#1c2f4a'    = 'var(--surface-sunken)';
  '#1c2a3a'    = 'var(--surface-sunken)';
  '#1a2a40'    = 'var(--surface-sunken)';
  '#1a2738'    = 'var(--surface-sunken)';
  '#233247'    = 'var(--surface-active)';
  '#2f4d77'    = 'var(--surface-active)';
  '#213a5e'    = 'var(--surface-active)';
  '#163050'    = 'var(--surface-active)';
  '#e2eaf4'    = 'var(--line-strong)';
  '#cfd9e6'    = 'var(--line-strong)';
  '#aab9cc'    = 'var(--muted)';

  # --- neutral surfaces (light side) ------------------------------------
  '#edf6ff'    = 'var(--panel)';
  '#f4f8ff'    = 'var(--raised)';
  '#e8f0ff'    = 'var(--panel)';
  '#e8f2ff'    = 'var(--panel)';
  '#d9ebff'    = 'var(--panel)';
  '#d3e4ff'    = 'var(--panel)';
  '#f0f4fa'    = 'var(--panel)';
  '#e3e8ef'    = 'var(--line)';
  '#e6efff'    = 'var(--line)';
  '#dde6f1'    = 'var(--line)';
  '#e6e0ff'    = 'var(--line)';
  '#ece5ff'    = 'var(--accent-soft)';
  '#f7f4ff'    = 'var(--raised)';
  '#7b5dff'    = 'var(--accent)';

  # --- misc -------------------------------------------------------------
  '#1f3a5a14'  = 'var(--shadow-sm)';
  '#1f3a5a1f'  = 'var(--shadow-md)';
  '#5d87b814'  = 'var(--shadow-sm)';
  '#5d87b822'  = 'var(--shadow-sm)';
  '#183a5e35'  = 'var(--theme-shadow)';
  '#fff'       = 'var(--accent-ink)';
  '#ffffff'    = 'var(--accent-ink)';
}

foreach ($entry in $map.GetEnumerator()) {
  $from = [regex]::Escape($entry.Key)
  $css = [regex]::Replace($css, "(?i)(?<![0-9a-f])$from(?![0-9a-f])", $entry.Value)
}

Set-Content -Path $path -Value $css -NoNewline
$remaining = ([regex]::Matches((Get-Content $path -Raw), '#[0-9a-fA-F]{3,8}\b')).Count
Write-Output "BackendSettingsDialog.css remapped. Remaining hex literals: $remaining"
