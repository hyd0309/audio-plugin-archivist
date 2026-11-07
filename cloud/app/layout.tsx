import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "效果器档案室 · 把手册放回创作",
  description: "用自己的模型阅读效果器手册，归档到自己的飞书，按创作需求选用。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
