import { CopyTextButton } from './CopyTextButton';

export function CopyMarkdownButton({ getText, label = '复制 Markdown' }: { getText: () => string; label?: string }) {
  return <CopyTextButton getText={getText} label={label} successMessage="已复制为 Markdown" />;
}
