import { FormEvent, useEffect, useState } from "react";

type Props = {
  currentUrl: string;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
};

export function NavigationBar({
  currentUrl,
  onNavigate,
  onBack,
  onForward,
}: Props) {
  const [inputUrl, setInputUrl] = useState(currentUrl);

  useEffect(() => {
    setInputUrl(currentUrl);
  }, [currentUrl]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const raw = inputUrl.trim();
    let formatted: string;
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      formatted = raw;
    } else if (raw.includes(".") || raw.includes("/")) {
      formatted = `https://${raw}`;
    } else {
      // "google" -> "https://www.google.com", "google flights" -> search
      const hasSpaces = raw.includes(" ");
      formatted = hasSpaces
        ? `https://www.google.com/search?q=${encodeURIComponent(raw)}`
        : `https://www.${raw}.com`;
    }
    onNavigate(formatted);
  };

  return (
    <form className="navBar" onSubmit={submit}>
      <button className="navBtn" type="button" onClick={onBack}>
        Back
      </button>
      <button className="navBtn" type="button" onClick={onForward}>
        Next
      </button>
      <input
        className="urlInput"
        value={inputUrl}
        onChange={(event) => setInputUrl(event.target.value)}
        aria-label="Browser URL"
        placeholder="Type a website or search words"
      />
      <button className="navBtn primary" type="submit">
        Open
      </button>
    </form>
  );
}
