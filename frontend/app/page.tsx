"use client";

import { useState, useRef, useEffect } from "react";

type Option = {
  name: string;
  description?: string;
  rating?: string;
  price?: string;
};

type MessageType = "default" | "clarification" | "options";

type Message = {
  role: "user" | "assistant";
  content: string;
  type?: MessageType;
  suggestions?: string[];
  options?: Option[];
};

type AppState = "url-input" | "connecting" | "chat" | "acting";

export default function Home() {
  const [url, setUrl] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>("url-input");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleOpenBrowser = async () => {
    if (!url.trim()) return;
    setError(null);
    setAppState("connecting");

    try {
      const res = await fetch("http://localhost:3001/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUrl: url }),
      });
      if (!res.ok) throw new Error("Server error");
      const data = await res.json();
      setSessionId(data.sessionId);
      setMessages([
        {
          role: "assistant",
          content: `I've opened ${url} for you. What would you like to do?`,
        },
      ]);
      setAppState("chat");
    } catch (_) {
      setError("Failed to open the browser. Make sure the server is running.");
      setAppState("url-input");
    }
  };

  const handleSendMessage = async (overrideInput?: string) => {
    const userMessage = (overrideInput ?? input).trim();
    if (!userMessage || !sessionId) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setAppState("acting");
    setError(null);

    try {
      const res = await fetch("http://localhost:3001/api/session/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, userGoal: userMessage }),
      });

      let data: any;
      try { data = await res.json(); } catch { data = { error: `HTTP ${res.status}` }; }

      if (!res.ok) {
        const errMsg = data.error ?? "Server error";
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${errMsg}`, type: "default" }]);
        setAppState("chat");
        return;
      }

      if (data.status === "needs_clarification") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.question, type: "clarification" },
        ]);
      } else {
        // action_complete
        const msgType: MessageType = data.extracted_options?.length ? "options" : "default";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.description ?? "Done!",
            type: msgType,
            suggestions: data.suggestions,
            options: data.extracted_options,
          },
        ]);
      }

      setAppState("chat");
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't complete that action. Please try again.", type: "default" },
      ]);
      setAppState("chat");
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    handleSendMessage(suggestion);
  };

  const handleOptionClick = (optionName: string) => {
    handleSendMessage(`Select ${optionName}`);
  };

  const handleEndSession = async () => {
    if (sessionId) {
      await fetch("http://localhost:3001/api/session/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    }
    setSessionId(null);
    setMessages([]);
    setUrl("");
    setAppState("url-input");
  };

  return (
    <div className="flex min-h-screen flex-col bg-black">
      <header className="border-b-4 border-yellow-400 p-6">
        <h1 className="text-center text-4xl font-black text-yellow-400">
          Nav-Mate
        </h1>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-2xl flex-1 flex flex-col">
          
          {/* STEP 1: URL Input */}
          {appState === "url-input" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-8">
              <p className="text-3xl font-bold text-white text-center">
                What website do you need help with?
              </p>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleOpenBrowser()}
                placeholder="e.g. https://google.com"
                className="w-full rounded-2xl border-4 border-yellow-400 bg-black p-6 text-3xl text-white placeholder-gray-500 focus:outline-none focus:ring-4 focus:ring-yellow-400"
              />
              {error && (
                <p className="text-2xl font-semibold text-red-400">{error}</p>
              )}
              <button
                onClick={handleOpenBrowser}
                disabled={!url.trim()}
                className="w-full rounded-2xl bg-yellow-400 py-7 text-4xl font-black text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                OPEN WEBSITE
              </button>
            </div>
          )}

          {/* CONNECTING */}
          {appState === "connecting" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-8">
              <div className="h-24 w-24 animate-spin rounded-full border-8 border-yellow-400 border-t-transparent" />
              <p className="text-4xl font-bold text-yellow-400">Opening browser...</p>
            </div>
          )}

          {/* CHAT INTERFACE */}
          {(appState === "chat" || appState === "acting") && (
            <div className="flex flex-1 flex-col">
              {/* Messages */}
              <div className="flex-1 overflow-y-auto space-y-6 pb-4">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {/* Clarification message */}
                    {msg.type === "clarification" ? (
                      <div className="max-w-[85%] rounded-2xl border-4 border-yellow-400 bg-gray-900 px-6 py-5">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-4xl">🎤</span>
                          <span className="text-lg font-black text-yellow-400 uppercase tracking-wide">I need more info</span>
                        </div>
                        <p className="text-2xl font-semibold text-white">{msg.content}</p>
                      </div>
                    ) : msg.type === "options" && msg.options && msg.options.length > 0 ? (
                      /* Options grid message */
                      <div className="max-w-[95%] w-full">
                        <p className="text-xl font-semibold text-gray-300 mb-3">{msg.content}</p>
                        <div className="grid grid-cols-1 gap-3">
                          {msg.options.map((opt, j) => (
                            <button
                              key={j}
                              onClick={() => handleOptionClick(opt.name)}
                              className="w-full rounded-2xl border-4 border-gray-600 bg-gray-800 px-6 py-5 text-left hover:border-yellow-400 hover:bg-gray-700 transition-colors"
                            >
                              <p className="text-2xl font-black text-white">{opt.name}</p>
                              {opt.description && <p className="text-lg text-gray-400 mt-1">{opt.description}</p>}
                              <div className="flex gap-4 mt-2">
                                {opt.rating && <span className="text-yellow-400 font-bold">⭐ {opt.rating}</span>}
                                {opt.price && <span className="text-green-400 font-bold">{opt.price}</span>}
                              </div>
                            </button>
                          ))}
                        </div>
                        {msg.suggestions && msg.suggestions.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-3">
                            {msg.suggestions.map((s, j) => (
                              <button key={j} onClick={() => handleSuggestionClick(s)}
                                className="rounded-xl border-2 border-yellow-400 px-4 py-2 text-lg font-bold text-yellow-400 hover:bg-yellow-400 hover:text-black transition-colors">
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* Default message */
                      <div className={`max-w-[85%] rounded-2xl px-6 py-5 ${
                        msg.role === "user" ? "bg-yellow-400 text-black" : "bg-gray-800 text-white"
                      }`}>
                        <p className="text-2xl font-semibold">{msg.content}</p>
                        {msg.suggestions && msg.suggestions.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-3">
                            {msg.suggestions.map((s, j) => (
                              <button key={j} onClick={() => handleSuggestionClick(s)}
                                className="rounded-xl border-2 border-yellow-400 px-4 py-2 text-lg font-bold text-yellow-400 hover:bg-yellow-400 hover:text-black transition-colors">
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {appState === "acting" && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl bg-gray-800 px-6 py-5">
                      <div className="flex items-center gap-3">
                        <div className="h-6 w-6 animate-spin rounded-full border-4 border-yellow-400 border-t-transparent" />
                        <p className="text-2xl font-semibold text-yellow-400">Working on it...</p>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="border-t-4 border-gray-800 pt-6">
                <div className="flex gap-4">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && appState === "chat" && handleSendMessage()}
                    placeholder="Tell me what to do..."
                    disabled={appState === "acting"}
                    className="flex-1 rounded-2xl border-4 border-yellow-400 bg-black p-5 text-2xl text-white placeholder-gray-500 focus:outline-none focus:ring-4 focus:ring-yellow-400 disabled:opacity-50"
                  />
                  <button
                    onClick={() => handleSendMessage()}
                    disabled={!input.trim() || appState === "acting"}
                    className="rounded-2xl bg-yellow-400 px-8 text-2xl font-black text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    SEND
                  </button>
                </div>
                <button
                  onClick={handleEndSession}
                  className="mt-4 w-full rounded-xl border-2 border-red-500 py-4 text-xl font-bold text-red-500 hover:bg-red-500 hover:text-white transition-colors"
                >
                  End Session & Close Browser
                </button>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
