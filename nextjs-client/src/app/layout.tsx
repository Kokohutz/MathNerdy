import type { Metadata } from "next";
import { Patrick_Hand, Caveat } from "next/font/google";
import "./globals.css";

// Pencil-drawn UI: Patrick Hand for body text, Caveat for headings/accents.
// The stroke-animated handwriting (HandwrittenText) uses its own vendored
// Hershey Script glyphs and doesn't depend on these fonts.
const patrickHand = Patrick_Hand({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-hand",
});
const caveat = Caveat({ subsets: ["latin"], variable: "--font-hand-accent" });

export const metadata: Metadata = {
  title: "Math Tutor on Groq",
  description: "Math Tutor Powered by Groq",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${patrickHand.variable} ${caveat.variable} ${patrickHand.className}`}
      >
        {children}
      </body>
    </html>
  );
}
