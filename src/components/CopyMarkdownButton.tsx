import { CopyTextButton, type CopyButtonHint } from './CopyTextButton';

export function CopyMarkdownButton({ getText, label = '复制 Markdown', iconOnly = false, hint, disabled = false }: { getText: () => string; label?: string; iconOnly?: boolean; hint?: CopyButtonHint; disabled?: boolean }) {
  return <CopyTextButton getText={getText} label={label} iconOnly={iconOnly} hint={hint} disabled={disabled} successMessage="已复制为 Markdown" />;
}
