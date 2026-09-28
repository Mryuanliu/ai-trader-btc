import { useState } from 'react';
import { Button, Drawer } from 'antd';
import { BookOutlined } from '@ant-design/icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// 直接以源码文本导入仓库根 docs/ 下的文档 —— 文档与代码同源，不会漂移
import guideMd from '../../../../docs/strategy-dev-guide.md?raw';

/**
 * 内联代码 / 代码块的统一暗色样式。
 */
const CODE_INLINE = 'rounded bg-white/[0.08] px-1 py-[1px] text-[12px] text-amber-300';

/**
 * Markdown 渲染的组件映射。
 *
 * react-markdown 本体不带任何样式，按暗色主题逐标签定制；
 * 表格走 remark-gfm（文档里大量对齐表格）。
 */
const mdComponents = {
  h1: (p: object) => (
    <h1 className="mb-3 border-b border-white/[0.08] pb-2 text-[17px] font-semibold text-white" {...p} />
  ),
  h2: (p: object) => (
    <h2 className="mt-6 mb-2 text-[15px] font-semibold text-white" {...p} />
  ),
  h3: (p: object) => (
    <h3 className="mt-4 mb-2 text-[13px] font-semibold text-white/90" {...p} />
  ),
  p: (p: object) => <p className="my-2 text-[13px] leading-relaxed text-white/80" {...p} />,
  ul: (p: object) => <ul className="my-2 list-disc pl-5 text-[13px] leading-relaxed text-white/80" {...p} />,
  ol: (p: object) => <ol className="my-2 list-decimal pl-5 text-[13px] leading-relaxed text-white/80" {...p} />,
  li: (p: object) => <li className="my-1" {...p} />,
  strong: (p: object) => <strong className="font-semibold text-white" {...p} />,
  a: (p: object) => <a className="text-up underline underline-offset-2" {...p} />,
  blockquote: (p: object) => (
    <blockquote
      className="my-3 border-l-2 border-white/20 pl-3 text-[12px] leading-relaxed text-muted"
      {...p}
    />
  ),
  hr: () => <hr className="my-4 border-white/[0.08]" />,
  code: (p: { className?: string; children?: React.ReactNode }) => {
    const isBlock = /language-/.test(p.className ?? '');
    if (isBlock) return <code className={p.className}>{p.children}</code>;
    return <code className={CODE_INLINE}>{p.children}</code>;
  },
  pre: (p: object) => (
    <pre
      className="my-3 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-3 text-[12px] leading-relaxed text-white/90"
      {...p}
    />
  ),
  table: (p: object) => (
    <div className="my-3 overflow-auto">
      <table className="w-full border-collapse text-[12px]" {...p} />
    </div>
  ),
  th: (p: object) => (
    <th className="border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left font-semibold text-white/90" {...p} />
  ),
  td: (p: object) => (
    <td className="border border-white/10 px-2 py-1.5 align-top text-white/75" {...p} />
  ),
};

/**
 * 「开发者文档」按钮 + 抽屉。
 *
 * 文档源 = 仓库 `docs/strategy-dev-guide.md`（Vite ?raw 导入，与代码同源），
 * 抽屉内 react-markdown + remark-gfm 渲染（表格/代码块齐全）。
 */
export function DevDocsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<BookOutlined />} onClick={() => setOpen(true)}>
        开发者文档
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={<span className="text-[14px]">策略开发指南 · docs/strategy-dev-guide.md</span>}
        width="min(880px, 94vw)"
        destroyOnClose
      >
        <div className="-mx-1 px-1 pb-6">
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {guideMd}
          </Markdown>
        </div>
      </Drawer>
    </>
  );
}
