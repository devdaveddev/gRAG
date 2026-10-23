"""Download plain-text intros of overlapping Wikipedia articles (CC BY-SA) into corpus.json."""
import json
import sys
import urllib.parse
import urllib.request

TITLES = ["Apple Inc.", "Microsoft", "Google", "Nvidia", "OpenAI", "Tesla, Inc.", "Amazon (company)", "Meta Platforms"]
CHARS = 7000

def fetch(title: str) -> str:
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "query", "prop": "extracts", "explaintext": 1, "titles": title, "format": "json", "redirects": 1}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "gRAG-eval/0.1 (research; contact via github)"})
    page = next(iter(json.load(urllib.request.urlopen(req, timeout=30))["query"]["pages"].values()))
    text = page["extract"]
    return text[:CHARS].rsplit(".", 1)[0] + "."

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "corpus.json"
    json.dump({t: fetch(t) for t in TITLES}, open(out, "w"), indent=1)
    print("saved", out)
