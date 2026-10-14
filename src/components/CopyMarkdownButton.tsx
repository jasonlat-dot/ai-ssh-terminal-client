import { CopyTextButton } from './CopyTextButton';

export function CopyMarkdownButton({ getText, label = '复制 Markdown', iconOnly = false }: { getText: () => string; label?: string; iconOnly?: boolean }) {
  return <CopyTextButton getText={getText} label={label} iconOnly={iconOnly} successMessage="已复制为 Markdown" />;
}
