# Snake Watch — AWS S3 Setup Guide

This form uploads photos and notes to **AWS S3** once you connect it (steps below).
Until then it runs in **demo mode** — uploads are kept in memory for the current
session only (nothing is written to the device). To store reports permanently and show
a shared list across all guests, connect AWS S3 using the steps below.

Everything here fits inside the **AWS Free Tier** for a low-traffic rental:
- **S3:** 5 GB storage, 20k GET, 2k PUT / month (first 12 months)
- **Lambda:** 1M requests + 400k GB-seconds / month (always free)
- **API Gateway (HTTP API):** 1M requests / month (first 12 months)

A single rental will realistically never leave the free tier.

---

## How the upload works

The browser should **never** hold AWS credentials. Instead:

1. The form asks a small **Lambda endpoint** for a short-lived **presigned PUT URL**.
2. The Lambda also writes the notes/metadata record (to a JSON file in S3, or DynamoDB).
3. The browser uploads the photo directly to S3 using that presigned URL.

```
[ Snake Watch form ] --POST notes--> [ API Gateway + Lambda ] --presign--> returns { uploadUrl, key }
        |                                        |
        |                                        +--> writes metadata record to S3
        +-------------------- PUT photo to uploadUrl --------------------> [ S3 bucket ]
```

---

## Step 1 — Create the S3 bucket

1. S3 → **Create bucket** → name it e.g. `snake-watch-rental`, region `us-east-1`.
2. Leave **Block all public access = ON**. Uploads go through presigned URLs, so the
   bucket never needs to be public.

## Step 2 — Add a CORS rule to the bucket

Bucket → **Permissions → CORS** → paste (replace the domain with where the form is hosted):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST", "GET"],
    "AllowedOrigins": ["https://your-form-domain.example"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

## Step 3 — Create the Lambda function

Yes — this is **AWS Lambda**, the serverless "function as a service" product. You paste
in a small piece of code; AWS runs it only when the form calls it (no server to keep
running or patch). Its job here is two things: store the notes record and hand the
browser a short-lived URL to upload the photo. At rental traffic this stays free
forever (1M requests/month are always free).

### 3a. Create the function

1. Sign in to the **AWS Console** → search for and open **Lambda** → **Create function**.
2. Choose **Author from scratch**.
3. **Function name:** `snake-watch-presign`
4. **Runtime:** **Node.js 20.x**
5. **Architecture:** leave as `x86_64`.
6. Click **Create function**.

### 3b. Give the function permission to write to S3

Lambda runs under an IAM "execution role". By default it can't touch your bucket, so
grant it just the two actions it needs:

1. On the function page → **Configuration** tab → **Permissions** → click the **Role name**
   link (opens IAM in a new tab).
2. **Add permissions → Create inline policy → JSON** → paste this (swap in your bucket
   name), then **Next → Create policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::snake-watch-photos-356325055182-us-east-2-an",
        "arn:aws:s3:::snake-watch-photos-356325055182-us-east-2-an/*"
      ]
    }
  ]
}
```

### 3c. Add the code

1. Back on the function page → **Code** tab.
2. In the file tree, open **`index.mjs`** (the default file). Select all and replace its
   contents with the code below.
3. Edit the `BUCKET` constant and the `region` to match yours.
4. Click **Deploy** (this saves and publishes the change).

> **About the AWS SDK:** the `@aws-sdk/*` packages used below are **built into the
> Node.js 20 Lambda runtime** — you do **not** need to upload or `npm install` anything.
> Just paste and Deploy.

### 3d. Bump the timeout (optional but recommended)

**Configuration → General configuration → Edit** → set **Timeout** to ~10 seconds and
**Memory** to 256 MB. Defaults work, but this avoids occasional cold-start timeouts.

You can't call the function from the browser yet — that's what Step 4 (API Gateway)
adds. You *can* test it now with **Test** → create a test event with a body like
`{"body":"{\"key\":\"sightings/test.jpg\",\"contentType\":\"image/jpeg\",\"metadata\":{}}"}`.

```js
// index.mjs  — presign + record handler
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-2" });
const BUCKET = "snake-watch-photos-356325055182-us-east-2-an";

// authoritative geofence config — the SERVER decides, never the browser
const TARGET = { lat: 34.53660217926452, lng: -93.50081788334796 };
const RADIUS_FT = 1000;

function distanceFeet(lat, lng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat - TARGET.lat), dLng = toRad(lng - TARGET.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(TARGET.lat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a)) * 3.28084;
}

export const handler = async (event) => {
  // CORS on EVERY response, including errors — otherwise the browser shows a
  // misleading CORS error instead of the real 500.
  const cors = {
    "Access-Control-Allow-Origin": "*",            // or lock to your domain
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
  const reply = (statusCode, obj) => ({
    statusCode, headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });

  // Log the whole incoming event so CloudWatch shows exactly what arrived.
  console.log("EVENT", JSON.stringify(event));

  try {
    const method = event.requestContext?.http?.method;
    if (method === "OPTIONS") return { statusCode: 204, headers: cors };

    // --- parse body defensively ---
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("BAD_JSON", event.body);
      return reply(400, { error: "body is not valid JSON" });
    }
    const { key, contentType, metadata = {} } = body;
    console.log("PARSED", { key, contentType, hasMeta: !!metadata });

    if (!key || !contentType) {
      return reply(400, { error: "missing key or contentType", got: { key, contentType } });
    }

    // --- RE-VERIFY THE GEOFENCE SERVER-SIDE ---
    const lat = Number(metadata.lat), lng = Number(metadata.lng);
    const hasCoords =
      Number.isFinite(lat) && Number.isFinite(lng) &&
      !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    let serverDistanceFt = null, locationStatus = "unverified";
    if (hasCoords) {
      serverDistanceFt = Math.round(distanceFeet(lat, lng));
      locationStatus = serverDistanceFt <= RADIUS_FT ? "verified" : "out_of_range";
    }
    console.log("GEOFENCE", { hasCoords, serverDistanceFt, locationStatus });

    // 1) store the metadata record
    const record = {
      ...metadata, key,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      distanceFt: serverDistanceFt,
      locationStatus,
      locationVerified: locationStatus === "verified",
      clientClaimedStatus: metadata.locationStatus ?? null,
      exifVerified: null,
      uploadedAt: new Date().toISOString(),
    };
    const jsonKey = key.replace(/\.[^.]+$/, ".json");
    console.log("PUT_JSON", jsonKey);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: jsonKey,
      Body: JSON.stringify(record), ContentType: "application/json",
    }));

    // 2) presigned URL for the photo PUT
    console.log("PRESIGN", key);
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 }
    );

    console.log("OK", key);
    return reply(200, { uploadUrl, key, locationStatus });
  } catch (err) {
    // Surface the REAL error to CloudWatch *and* to the browser response.
    console.error("HANDLER_ERROR", err?.name, err?.message, err?.stack);
    return reply(500, { error: err?.message || "unknown", name: err?.name || null });
  }
};
```

## Step 4 — Expose it with API Gateway (HTTP API)

1. API Gateway → **Create HTTP API** → integrate with the Lambda.
2. Add a route `POST /upload` and enable **CORS** for your domain.
3. Copy the invoke URL, e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/upload`.

---

## Troubleshooting a 500 error from the Lambda

A `500` with nothing useful in CloudWatch almost always means the function **crashed
before your code ran** (a config/permission/runtime problem), so your `console.log`
lines never executed. Work through this list:

### 1. Use the instrumented code above

The Step 3 handler now wraps everything in `try/catch`, logs the incoming event, and
returns the **real error message** in the JSON response (with CORS headers, so the
browser can read it instead of masking it as a CORS error). After deploying it, retry
an upload and look at the response body in your browser's **Network tab** — it will now
say e.g. `{"error":"Access Denied","name":"AccessDenied"}`.

### 2. Test the Lambda in isolation (bypasses API Gateway + CORS)

In the Lambda console → **Test** tab → create an event and **Invoke**. This runs the
function directly so you see the raw result and logs without the browser in the way:

```json
{
  "requestContext": { "http": { "method": "POST" } },
  "body": "{\"key\":\"sightings/test.jpg\",\"contentType\":\"image/jpeg\",\"metadata\":{\"lat\":34.5366,\"lng\":-93.5008,\"notes\":\"test\"}}"
}
```

If this fails, the problem is the Lambda itself (not CORS, not the browser). The
**Execution results** panel shows the thrown error and the full log.

### 3. Most common causes (in order)

- **Missing S3 permission** → error `AccessDenied`. The function's execution role needs
  `s3:PutObject` on `arn:aws:s3:::YOUR_BUCKET/*`. Re-check Step 3b, and make sure the
  bucket **name in the code** matches your real bucket exactly.
- **Wrong region** → error like `PermanentRedirect` or a hang/timeout. The `region` in
  `new S3Client({ region: ... })` must match the bucket's region. Your endpoint is in
  `us-east-2` — if the bucket is also `us-east-2`, set `region: "us-east-2"` in **both**
  Lambdas (the SETUP examples say `us-east-1`).
- **SDK import fails** → error `Cannot find package '@aws-sdk/...'`. The `@aws-sdk/client-s3`
  and `@aws-sdk/s3-request-presigner` packages are built into the **Node.js 20** runtime.
  If you picked an older runtime, switch to Node.js 20.x (Configuration → Runtime
  settings), or bundle the packages in a zip.
- **Timeout** (default 3s) → log ends with `Task timed out`. Bump it to ~10s
  (Configuration → General configuration). Usually paired with a region mismatch.
- **API Gateway not parsing** → if `event.body` is `undefined` in the logs, your route
  isn't passing the body through; confirm it's an **HTTP API** with a `POST /upload`
  route integrated with this function (payload format **2.0**).

### 4. Where to read the logs

Lambda console → **Monitor** tab → **View CloudWatch logs** → newest log stream. With
the instrumented code you'll see `EVENT`, `PARSED`, `GEOFENCE`, `PUT_JSON`, `PRESIGN`,
`OK` — whichever is the **last** line before an error tells you exactly which step
failed. `HANDLER_ERROR` lines include the name, message, and stack.

## Step 5 — Point the form at it

In **`Snake Watch.dc.html`**, find the `config` block in the logic class and set
`uploadEndpoint`:

```js
config = {
  target: { lat: 34.53660217926452, lng: -93.50081788334796 },
  radiusFeet: 1000,
  uploadEndpoint: 'https://7wstcuqfu5.execute-api.us-east-2.amazonaws.com/upload',
  region: 'us-east-2',
  bucket: 'snake-watch-photos-356325055182-us-east-2-an',
};
```

The status chip on the Report tab flips from *Demo mode* to *Cloud storage connected*
automatically. On submit, the photo goes to S3 and the metadata JSON sits beside it.

---

## Step 6 — Server-side anti-spoofing (recommended)

Because the browser extracts the GPS and could be tampered with (or someone could
`POST` straight to your API with made-up coordinates), the form's status is only a
**hint**. Treat it as untrusted and verify on the server in two layers:

### Layer 1 — Recompute the geofence (already done in Step 3)

The presign Lambda above **ignores** the browser's `locationStatus` and recomputes
`distanceFt` + `locationStatus` from the submitted `lat/lng` using its own copy of the
target coordinates and radius. The browser's claim is kept only as
`clientClaimedStatus` for auditing. This stops a client that lies about *status* while
sending real coordinates.

### Layer 2 — Re-extract GPS from the actual image (defeats coordinate spoofing)

Layer 1 still trusts the `lat/lng` the browser typed in. To guard against forged
coordinates, re-read the EXIF GPS **from the uploaded JPEG itself** after it lands in
S3, and compare it to what was claimed. Mismatch ⇒ mark the record `unverified` and
flag it.

This runs as a **second Lambda triggered by S3** (not API Gateway), because the photo
only exists once the browser's presigned `PUT` completes.

**Create it:**

1. Lambda → **Create function** → name `snake-watch-verify`, runtime **Node.js 20.x**.
2. Give its role `s3:GetObject` + `s3:PutObject` on the bucket (same inline policy as Step 3b).
3. This function needs the `exifr` package, which is **not** in the runtime. Easiest:
   Lambda console → **Layers**, or just zip a small project: `npm init -y && npm i exifr`,
   put the code in `index.mjs`, zip the folder (including `node_modules`), and upload.
4. **Configuration → Triggers → Add trigger → S3** → your bucket → event type
   **All object create events** → **Prefix** `sightings/` (no suffix — the code below
   skips the `.json` records itself, so it works for `.jpg`, `.png`, `.heic`, etc.).

```js
// index.mjs  — runs when a photo is written to S3
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import exifr from "exifr";

const s3 = new S3Client({ region: "us-east-2" });
const BUCKET = "snake-watch-photos-356325055182-us-east-2-an";
const TARGET = { lat: 34.53660217926452, lng: -93.50081788334796 };
const RADIUS_FT = 1000;
const MISMATCH_FT = 300;   // how far claimed vs real may differ before we flag it

function distanceFeet(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a)) * 3.28084;
}
const buf = async (stream) => {
  const chunks = []; for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

export const handler = async (event) => {
  for (const rec of event.Records) {
    const Bucket = rec.s3.bucket.name;
    const Key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, " "));
    if (Key.endsWith(".json")) continue;   // ignore the metadata records themselves
    const jsonKey = Key.replace(/\.[^.]+$/, ".json");

    // load the photo bytes and the record we wrote at presign time
    const img = await s3.send(new GetObjectCommand({ Bucket, Key }));
    const bytes = await buf(img.Body);
    let record = {};
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: jsonKey }));
      record = JSON.parse((await buf(r.Body)).toString());
    } catch (e) {}

    // the source of truth: GPS embedded in the uploaded image
    let gps = null;
    try { gps = await exifr.gps(bytes); } catch (e) {}
    const has = gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)
      && !(gps.latitude === 0 && gps.longitude === 0);

    if (!has) {
      // no real GPS in the file → cannot be verified, whatever was claimed
      record.exifVerified = false;
      record.locationStatus = "unverified";
      record.locationVerified = false;
      record.flag = record.lat != null ? "claimed-coords-but-image-has-none" : null;
    } else {
      const realDist = Math.round(distanceFeet(TARGET.lat, TARGET.lng, gps.latitude, gps.longitude));
      // does the image's GPS match the coordinates the browser claimed?
      const claimMatches = record.lat == null ? false :
        distanceFeet(record.lat, record.lng, gps.latitude, gps.longitude) <= MISMATCH_FT;

      record.exifLat = gps.latitude;
      record.exifLng = gps.longitude;
      record.exifDistanceFt = realDist;
      record.exifVerified = claimMatches;
      // recompute authoritative status from the IMAGE's own coordinates
      record.lat = gps.latitude;
      record.lng = gps.longitude;
      record.distanceFt = realDist;
      record.locationStatus = realDist <= RADIUS_FT ? "verified" : "out_of_range";
      record.locationVerified = record.locationStatus === "verified";
      if (!claimMatches) record.flag = "claimed-coords-differ-from-image";
    }
    record.verifiedAt = new Date().toISOString();

    await s3.send(new PutObjectCommand({
      Bucket, Key: jsonKey,
      Body: JSON.stringify(record), ContentType: "application/json",
    }));
  }
  return { ok: true };
};
```

After this runs, each record's `locationStatus` / `locationVerified` reflect the GPS
**actually baked into the photo file** — not anything the browser sent. Records carrying
a `flag` (`claimed-coords-differ-from-image`, etc.) are the ones to review or hide. When
you wire up "reading sightings back" below, drive the gallery badge off these
server-written fields.

> **Note on EXIF:** the form uploads the **original photo bytes** (EXIF intact) to S3 —
> the downscaled image is used only for the on-screen preview and thumbnail — so Layer 2
> works out of the box. The one thing that still strips GPS is the *source* photo lacking
> it (location was off, or it came through a messaging app). Those correctly resolve to
> `unverified`. For a rental's low stakes, Layer 1 alone is usually enough; Layer 2 adds
> defense against forged coordinates.

---

## Step 10 — Shared sightings list (`GET /sightings`)

So every guest sees **all** uploaded sightings (not just their own session), add a
read endpoint. The Lambda lists the metadata records in S3, returns the most recent N as
a JSON array, and includes a short-lived presigned URL for each photo. The form fetches
it on load via `config.listEndpoint`.

**Design notes**
- It sorts by S3 `LastModified` (≈ upload time) and **caps the count** (default 100) so
  a busy bucket never returns thousands of items or blows past free tier.
- It already parses `from`, `to`, and `limit` **query-string params**, so you can turn on
  **time-range filtering later** with zero code changes — just have the form append
  `?from=2026-06-01&to=2026-07-01` to the endpoint. Today the form sends none, so it
  returns the latest `DEFAULT_LIMIT`.

### 10a. Create the function

1. Lambda → **Create function** → name `snake-watch-list`, runtime **Node.js 20.x**.
2. Its execution role needs `s3:ListBucket` + `s3:GetObject` (the Step 3b inline policy
   already grants both — reuse it).
3. Add an **API Gateway** route **`GET /sightings`** integrated with this function
   (same HTTP API as `/upload`), and enable **CORS** for your Amplify domain.
4. Set **`listEndpoint`** in the form's `config` to the route URL, e.g.
   `https://7wstcuqfu5.execute-api.us-east-2.amazonaws.com/sightings`, then re-bundle and
   redeploy.

```js
// index.mjs  — GET /sightings : shared, capped, time-range-ready
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-2" });
const BUCKET = "snake-watch-photos-356325055182-us-east-2-an";
const PREFIX = "sightings/";
const DEFAULT_LIMIT = 100;   // returned when no ?limit is given
const MAX_LIMIT = 500;       // hard ceiling, protects free tier
const URL_TTL = 3600;        // presigned photo URL lifetime (seconds)

const buf = async (stream) => {
  const chunks = []; for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",            // or lock to your Amplify domain
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  };
  const reply = (statusCode, obj) => ({
    statusCode, headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });
  if (event.requestContext?.http?.method === "OPTIONS") return { statusCode: 204, headers: cors };

  try {
    // --- query params (all optional; time-range is future-proofed here) ---
    const q = event.queryStringParameters || {};
    const limit = Math.min(parseInt(q.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    const from = q.from ? new Date(q.from) : null;   // ISO date, e.g. 2026-06-01
    const to   = q.to   ? new Date(q.to)   : null;
    const inRange = (d) =>
      (!from || d >= from) && (!to || d <= to);

    // --- 1) list every metadata record (paginated) ---
    let items = [], token;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token,
      }));
      for (const o of page.Contents || []) {
        if (!o.Key.endsWith(".json")) continue;            // skip the photos
        if (!inRange(new Date(o.LastModified))) continue;  // time-range filter
        items.push({ key: o.Key, modified: o.LastModified });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    // --- 2) newest first, then cap ---
    items.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    items = items.slice(0, limit);

    // --- 3) fetch each record + presign its photo ---
    const records = await Promise.all(items.map(async ({ key }) => {
      let rec = {};
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        rec = JSON.parse((await buf(r.Body)).toString());
      } catch (e) { return null; }
      if (rec.key) {
        try {
          rec.dataUrl = await getSignedUrl(
            s3, new GetObjectCommand({ Bucket: BUCKET, Key: rec.key }),
            { expiresIn: URL_TTL }
          );
        } catch (e) {}
      }
      rec.storage = "s3";
      return rec;
    }));

    return reply(200, records.filter(Boolean));
  } catch (err) {
    console.error("LIST_ERROR", err?.name, err?.message);
    return reply(500, { error: err?.message || "unknown" });
  }
};
```

The form's `loadFromCloud()` already expects exactly this shape — a JSON array of
records, each with a `dataUrl` (here a presigned photo URL), `notes`, `capturedAt`,
`distanceFt`, `lat`/`lng`, and `locationStatus`. Once `listEndpoint` is set, the
Sightings tab (and its map view) renders the shared cloud list for everyone.

> **Turning on time filtering later:** no Lambda change needed. Add date inputs to the
> form and fetch `` `${listEndpoint}?from=${fromIso}&to=${toIso}&limit=200` ``. Tell me
> when you want that UI and I'll wire it into the Sightings tab.

> **Scaling note:** this reads one S3 object per returned record (fine for a rental's
> volume and well within free tier). If the bucket ever holds tens of thousands of
> sightings, move the records into **DynamoDB** (write them from the presign Lambda) and
> query by a date index instead of listing S3 — the form contract stays identical.

## Cost guardrails

- Add an **S3 lifecycle rule** to delete objects older than N months if you don't want
  to keep history forever.
- Set an **AWS Budgets** alert at $1 so you're emailed the moment anything bills.
- Keep the presigned URL `expiresIn` short (5 min) so links can't be reused.

---

## Hosting the form on AWS (Amplify Hosting)

The form is a single static file, so the simplest AWS host is **Amplify Hosting** — it
gives you HTTPS and a CDN with almost no setup, and stays inside the free tier for a
rental. HTTPS matters here: the form needs a secure origin to read photo location and
to `fetch` your API Gateway endpoint.

You can host either file:
- **`snake-watch.html`** — the full form (Report + Sightings tabs).
- **`snake-widget.html`** — the compact upload-only widget, if you're embedding it.

### Step 7 — Deploy with Amplify (drag-and-drop)

1. Rename the file you want to host to **`index.html`** (Amplify serves `index.html` by
   default). Put it by itself in a folder, then **zip that folder**.
2. AWS Console → search **Amplify** → **Create new app** → **Deploy without Git**
   (a.k.a. "Host a static site" / manual deploy).
3. Give the app a name (e.g. `snake-watch`), choose an environment name like `main`,
   and **drag the zip** onto the upload box → **Save and deploy**.
4. After a minute you get a live HTTPS URL like
   `https://main.d1234abcd.amplifyapp.com`. Open it to confirm the form loads.

> To update later, just **Deploy** a new zip — or connect a Git repo (GitHub, etc.) and
> Amplify auto-rebuilds on every push.

### Step 8 — Allow the new domain through CORS

Your form's domain is now the Amplify URL, so add it everywhere the browser is checked
(this is the same origin issue as the earlier `rest.edit.site` error):

1. **API Gateway → your HTTP API → CORS** → set **Access-Control-Allow-Origin** to your
   Amplify URL, e.g. `https://main.d1234abcd.amplifyapp.com` (or `*` to test first).
2. **S3 bucket → Permissions → CORS** → set `AllowedOrigins` to the same Amplify URL.
3. If your Lambda also returns an `Access-Control-Allow-Origin` header, make it match —
   don't set conflicting values in two places.

### Step 9 — (optional) Custom domain

Amplify → your app → **Domain management** → **Add domain**. If the domain is in Route 53
it's automatic; otherwise add the CNAME records Amplify shows you at your registrar.
Amplify provisions the SSL certificate for you. Remember to add the custom domain to the
CORS allow-lists in Step 8 too.

### Cost

Amplify Hosting's free tier (build minutes + GB served/stored per month) far exceeds a
single rental's traffic. As with the rest of the stack, set an **AWS Budgets** alert at
$1 so you're notified if anything ever bills.

### Alternative: S3 + CloudFront

If you'd rather keep everything in one bucket/account, you can host the file in S3 and
put **CloudFront** in front for HTTPS + CDN. It's cheaper at scale but more setup (plain
S3 website hosting is HTTP-only, so CloudFront is required for the secure origin the form
needs). Amplify is the lower-effort path for the same result.
