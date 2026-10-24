"""Weekly report from the 4̅2̅9̅ event journal, read straight from Chrome's profile on disk (no tab, no browser needed).

    python tools/journal_report.py [--days 7] [--profile "C:\\Users\\Homee\\AppData\\Local\\Google\\Chrome\\User Data\\Default"]

The journal (<=400 newest events) lives in chrome.storage.local of the extension (LevelDB). The newest data is in the
uncompressed write-ahead .log, which is what this script parses; if the journal was already compacted into .ldb (snappy) it says so.
It copies the directory first (the live one is locked) and never writes into the profile.
"""
import argparse, datetime, glob, json, os, shutil, struct, sys, tempfile
from collections import Counter

EXT_ID = "ekcbdaofgdanmgdopbmolnlcpjcenhoo"   # 4̅2̅9̅, unpacked from C:\projects\anti429\extension


def read_values(logfile):
    b = open(logfile, "rb").read(); recs = []; cur = b""; pos = 0
    while pos < len(b):
        end = (pos // 32768 + 1) * 32768
        if end - pos < 7:
            pos = end; continue
        _crc, ln, ty = struct.unpack("<IHB", b[pos:pos + 7]); pos += 7
        if ty == 0 and ln == 0:
            pos = end; continue
        d = b[pos:pos + ln]; pos += ln
        if ty == 1: recs.append(d)
        elif ty == 2: cur = d
        elif ty == 3: cur += d
        elif ty == 4: cur += d; recs.append(cur); cur = b""

    def vi(d, i):
        r = s = 0
        while True:
            x = d[i]; i += 1; r |= (x & 0x7f) << s; s += 7
            if x < 128: return r, i
    vals = {}
    for r in recs:
        i = 12; cnt = struct.unpack("<I", r[8:12])[0]
        for _ in range(cnt):
            t = r[i]; i += 1; kl, i = vi(r, i); k = r[i:i + kl]; i += kl
            if t == 1:
                vl, i = vi(r, i); vals[k] = r[i:i + vl]; i += vl
    return vals


def main():
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--profile", default=os.path.join(os.environ["LOCALAPPDATA"], "Google", "Chrome", "User Data", "Default"))
    a = ap.parse_args()
    src = os.path.join(a.profile, "Local Extension Settings", EXT_ID)
    tmp = tempfile.mkdtemp(prefix="a429j_")
    for f in glob.glob(os.path.join(src, "*")):
        try: shutil.copy(f, tmp)
        except OSError: pass
    vals = {}
    for f in sorted(glob.glob(os.path.join(tmp, "*.log"))):
        vals.update(read_values(f))
    shutil.rmtree(tmp, ignore_errors=True)
    if b"journal" not in vals:
        print("journal not found in the write-ahead log (maybe compacted into .ldb); nothing to report"); return
    J = sorted(json.loads(vals[b"journal"].decode("utf-8")), key=lambda e: e["t"])
    now = datetime.datetime.now()
    cut = (now - datetime.timedelta(days=a.days)).timestamp() * 1000
    hh = lambda t: datetime.datetime.fromtimestamp(t / 1000).strftime("%m-%d %H:%M")
    W = [e for e in J if e["t"] >= cut]
    print("# 4̅2̅9̅ journal report, generated %s" % now.strftime("%Y-%m-%d %H:%M"))
    print("Journal holds %d events (%s .. %s); window %.0f days -> %d events." % (len(J), hh(J[0]["t"]), hh(J[-1]["t"]), a.days, len(W)))
    if J[0]["t"] > cut:
        print("NOTE: the journal keeps only the newest 400 events, so it starts later than the requested window.")
    kinds = Counter(e["e"] for e in W)
    print("Event counts:", dict(kinds))
    c429 = [e for e in W if e["e"] == "429"]
    print("\n## 429s: %d" % len(c429))
    if c429:
        print("- by family:", dict(Counter(e["fam"] for e in c429)))
        print("- last 429: %s ; with 0 accepted before the refusal (server already hot): %d" % (hh(c429[-1]["t"]), sum(1 for e in c429 if e.get("acc") == 0)))
        days = Counter(datetime.datetime.fromtimestamp(e["t"] / 1000).strftime("%m-%d") for e in c429)
        print("- per day:", dict(sorted(days.items())))
    print("\n## Self-protection actions")
    for k in ("hib", "heal", "heal-pause", "restart-queued", "restart", "restart-lost", "restart-failed", "mem-discard", "tab-storm"):
        print("- %s: %d" % (k, kinds.get(k, 0)))
    pauses = [e for e in W if e["e"] == "heal-pause"]
    if pauses: print("- longest heal pause: %d min (streak %d)" % (max(e["min"] for e in pauses), max(e["streak"] for e in pauses)))
    news = [e for e in W if e["e"] == "tab-new"]
    print("\n## New ChatGPT tabs: %d (with no opener, i.e. opened programmatically: %d; stole focus: %d)" % (len(news), sum(1 for e in news if not e.get("opener")), sum(1 for e in news if e.get("active"))))
    mins = [e for e in W if e["e"] == "min"]
    other = Counter()
    for e in mins:
        for k, v in (e.get("other") or []): other[k] += v
    print("\n## Busiest non-limiter backend traffic (sum over minute summaries)")
    for k, v in other.most_common(8): print("- %5d  %s" % (v, k))
    top = Counter()
    for e in mins:
        for x in e.get("top", []): top[x["t"]] += x["req"]
    print("\n## Busiest tabs by title (requests summed)")
    for k, v in top.most_common(6): print("- %5d  %s" % (v, k))
    held = [e.get("held", 0) for e in mins]
    if held: print("\nHeld requests per minute: avg %.1f, max %d" % (sum(held) / len(held), max(held)))
    print("\nHow to read: many 429 with acc=0 and few of our own requests mean an outside source; restarts/hib > 0 mean the protections worked.")


if __name__ == "__main__":
    main()
