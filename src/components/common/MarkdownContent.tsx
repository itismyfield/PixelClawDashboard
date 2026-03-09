import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  content: string;
  className?: string;
}

export default function MarkdownContent({ content, className }: Props) {
  if (!content.trim()) return null;

  const classes = ["pcd-markdown", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content.replace(/\r\n/g, "\n")}
      </ReactMarkdown>
    </div>
  );
}
