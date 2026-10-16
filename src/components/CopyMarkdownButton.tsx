import { CopyTextButton, type CopyButtonHint } from './CopyTextButton';

export function CopyMarkdownButton({ getText, label = '复制 Markdown', iconOnly = false, hint }: { getText: () => string; label?: string; iconOnly?: boolean; hint?: CopyButtonHint }) {
  return <CopyTextButton getText={getText} label={label} iconOnly={iconOnly} hint={hint} successMessage="已复制为 Markdown" />;
}
