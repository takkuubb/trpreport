#!/usr/bin/env python3
"""Post-import enrichment for stay records: nationality estimation + Gmail guest fetch"""
import json, sys, re, os, urllib.request, urllib.parse, ssl, time, base64

YEAR_MONTH = sys.argv[1] if len(sys.argv) > 1 else None
if not YEAR_MONTH:
    print("Usage: enrich_stay.py YYYY-MM", file=sys.stderr)
    sys.exit(1)

CLIENT_ID = os.environ.get("GMAIL_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GMAIL_CLIENT_SECRET", "")
REFRESH_TOKEN = os.environ.get("GMAIL_REFRESH_TOKEN", "")
ctx = ssl.create_default_context()

def get_token():
    data = urllib.parse.urlencode({
        'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET,
        'refresh_token': REFRESH_TOKEN, 'grant_type': 'refresh_token'
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data)
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())['access_token']

def gmail_search(token, query, max_results=3):
    url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages?q={urllib.parse.quote(query)}&maxResults={max_results}"
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, context=ctx) as r:
            return json.loads(r.read()).get('messages', [])
    except:
        return []

def gmail_get(token, msg_id):
    url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}?format=full"
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, context=ctx) as r:
            return json.loads(r.read())
    except:
        return None

def decode_body(msg):
    parts = msg.get('payload', {}).get('parts', [])
    body_data = msg.get('payload', {}).get('body', {}).get('data', '')
    texts = []
    if body_data:
        texts.append(base64.urlsafe_b64decode(body_data + '==').decode('utf-8', errors='ignore'))
    for part in parts:
        if part.get('mimeType', '').startswith('text/'):
            data = part.get('body', {}).get('data', '')
            if data:
                texts.append(base64.urlsafe_b64decode(data + '==').decode('utf-8', errors='ignore'))
        for sub in part.get('parts', []):
            data = sub.get('body', {}).get('data', '')
            if data:
                texts.append(base64.urlsafe_b64decode(data + '==').decode('utf-8', errors='ignore'))
    return '\n'.join(texts)

def parse_guests(text):
    adults = children = infants = 0
    m = re.search(r'大人\s*[:：]?\s*(\d+)', text)
    if m: adults = int(m.group(1))
    m = re.search(r'子供\s*[:：]?\s*(\d+)', text)
    if m: children = int(m.group(1))
    m = re.search(r'幼児\s*[:：]?\s*(\d+)', text)
    if m: infants = int(m.group(1))
    if adults == 0:
        m = re.search(r'(\d+)\s*adult', text, re.I)
        if m: adults = int(m.group(1))
    if children == 0:
        m = re.search(r'(\d+)\s*child', text, re.I)
        if m: children = int(m.group(1))
    if infants == 0:
        m = re.search(r'(\d+)\s*infant', text, re.I)
        if m: infants = int(m.group(1))
    if adults == 0 and children == 0:
        m = re.search(r'ゲスト\s*[:：]?\s*(\d+)\s*人', text)
        if m: adults = int(m.group(1))
    if adults == 0 and children == 0:
        m = re.search(r'(\d+)\s*guest', text, re.I)
        if m: adults = int(m.group(1))
    return adults, children, infants, adults + children + infants

# Read records from stdin
records = json.load(sys.stdin)
needs_guests = [r for r in records if r.get('needs_guests')]
needs_nat = [r for r in records if r.get('needs_nationality')]

results = {'guests': [], 'nationality': []}

# Nationality estimation (fast, no API)
JP_HIRA = re.compile(r'[\u3040-\u309F]')
JP_KATA = re.compile(r'[\u30A0-\u30FF]')
HW_KATA = re.compile(r'[\uFF61-\uFF9F]')
KR_HANG = re.compile(r'[\uAC00-\uD7AF]')
CJK = re.compile(r'[\u4E00-\u9FFF]')
HEBREW = re.compile(r'[\u0590-\u05FF]')

JP_SN = {"佐藤","鈴木","高橋","田中","伊藤","渡辺","山本","中村","小林","加藤","吉田","山田","松本","井上","木村","斉藤","清水","山口","池田","橋本","阿部","石川","前田","藤田","岡田","後藤","長谷川","村上","近藤","石井","坂本","遠藤","青木","藤井","西村","福田","太田","三浦","岡本","松田","中島","原田","小野","河野","金城","上田","野口","小川","五十嵐","進藤","宮城","宮島","熊澤","秀島","久村","吉永","成田","村田","藤江","髙村","田松","菅沼","品田","大場","大津","工藤","塚平","小野田","池内","立松","難波","尾野","浅井","細野","深野","中地","岩元","金山","丹羽","馬場","佐野","林田","岩井","武林","北村","小泉","秋山","皆見","守屋","酒井","横山","森重","林","森","藤","島","杉","宮","谷","石"}
CN_SN = {"王","李","張","劉","陳","楊","黃","趙","吳","周","林","宋","鄭","何","曾","詹","游","郭","歐","刘","黄","謝","呂","方","霖","侯","常","杨"}
THAI_PAT = re.compile(r'porn|pun|chai|siri|wan|rat|thip|thong|pong|phon|sak|kit|korn|ari[np]|panid|pairin|sorns|suteema|teerav|thanp|palawan|chairo|maksung|ensarn|panarat|wuttis|compoo|kangwan|chanya|krish|nimsaeng|chuenarrom|thamachoto|akkharanant', re.I)

def guess_nat(name):
    if not name or not name.strip(): return "Unknown"
    n = re.sub(r'\s*\((調整金|解決の受取金)\)', '', name).strip()
    if JP_HIRA.search(n) or JP_KATA.search(n) or HW_KATA.search(n): return "Japan"
    if KR_HANG.search(n): return "South Korea"
    if HEBREW.search(n): return "Israel"
    if CJK.search(n):
        parts = re.split(r'[\u3000\s]+', n)
        for p in parts:
            if p in JP_SN: return "Japan"
        for p in parts:
            if p in CN_SN: return "China"
        return "Japan"
    # Romaji JP
    if re.search(r'\b(Nakagawa|Yokobori|Hirano|Imada|Fujitani|Ishida|Terabe|Morikawa|Ogawa|Onishi|Mori|Koyanagi|Takara|Toyama|Kinoshita|Mizutani|Sugitani|Nifu|Yamada|Nakamura|Honda|Kiyama|Sugiyama|Kikuchi|Higuchi|Tsukahara|Kogawa|Meguro|Ohara)\b', n, re.I):
        return "Japan"
    if THAI_PAT.search(n) and len(n) > 8: return "Thailand"
    if re.search(r'\bNguyen\b|\bTran\b|\bPham\b|\bHoàng\b|\bLâm\b|\bTrang\b', n, re.I): return "Vietnam"
    if re.search(r'\bMohd\b|\bNur\b|\bBin\b|\bWan\b|\bSiti\b|\bShafie\b|\bAmizah\b|\bHalus\b|\bAfifah\b', n, re.I): return "Malaysia"
    if re.search(r'\bKumar\b|\bSingh\b|\bGupta\b|\bSharma\b|\bPatel\b|\bMishra\b|\bDeshpande\b|\bSachdeva\b|\bJadhav\b', n, re.I): return "India"
    if re.search(r'\bHuang\b|\bChen\b|\bWang\b|\bZhang\b|\bLiu\b|\bJiang\b|\bQian\b|\bZhong\b|\bRuan\b|\bZhou\b', n, re.I): return "China"
    if re.search(r'\bLeung\b|\bNg\b|\bCheung\b|\bCheong\b|\bPoon\b|\bTsui\b|\bLui\b|\bYee\b|\bChung\b|\bChan\b', n, re.I): return "Hong Kong"
    if re.search(r'\bTseng\b|\bLin\b|\bShen\b|\bYeh\b|\bYu-Ting\b', n, re.I): return "Taiwan"
    if re.search(r'\bSchmidt\b|\bSchirmer\b|\bSchlich\b|\bBleckmann\b|\bKrebs\b|\bDietz\b|\bWagner\b|\bFischer\b|\bWartner\b|\bVoelker\b', n, re.I): return "Germany"
    if re.search(r'\bJoly\b|\bAnceaux\b|\bLe Blanc\b|\bMarcet\b|\bBergeron\b|\bGiraud\b|\bBlondeau\b|\bCharvet\b|\bChemla\b', n, re.I): return "France"
    if re.search(r'\bKim\b|\bLee\b|\bPark\b|\bChoi\b|\bJung\b|\bKang\b|\bYoon\b|\bPyun\b', n, re.I) and not re.search(r'\b[A-Z][a-z]+\s+Lee\b', n): return "South Korea"
    return "Unknown"

for r in needs_nat:
    nat = guess_nat(r['guest_name'])
    if nat != "Unknown":
        results['nationality'].append({'confirmation_code': r['confirmation_code'], 'nationality': nat})

print(f"Nationality estimated: {len(results['nationality'])}/{len(needs_nat)}", file=sys.stderr)

# Guest count fetch via Gmail
if needs_guests:
    try:
        token = get_token()
        print(f"Fetching guests for {len(needs_guests)} records...", file=sys.stderr)
        for i, r in enumerate(needs_guests):
            code = r['confirmation_code']
            if code.startswith('ADJ-'): continue
            msgs = gmail_search(token, f'"{code}" subject:reminder OR subject:リマインダー', 3)
            if not msgs:
                msgs = gmail_search(token, f'"{code}"', 3)
            if msgs:
                msg = gmail_get(token, msgs[0]['id'])
                if msg:
                    text = decode_body(msg)
                    a, c, inf, t = parse_guests(text)
                    if t > 0:
                        results['guests'].append({'confirmation_code': code, 'adults': a, 'children': c, 'infants': inf, 'total_guests': t})
            if (i+1) % 20 == 0:
                print(f"  {i+1}/{len(needs_guests)} processed, found {len(results['guests'])}", file=sys.stderr)
                time.sleep(0.3)
    except Exception as e:
        print(f"Gmail fetch error: {e}", file=sys.stderr)

print(f"Guests found: {len(results['guests'])}/{len(needs_guests)}", file=sys.stderr)
json.dump(results, sys.stdout, ensure_ascii=False)
