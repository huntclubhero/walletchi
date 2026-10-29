/* CHI CHAT GIFs (runner/chat.ts). One nullable column: the GIPHY gif a line carries, as JSON. */
ALTER TABLE "ChatMessage" ADD COLUMN "gif" TEXT;
