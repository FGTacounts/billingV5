# Creating users from the iOS app

Public sign-up should stay **off** in Supabase. With it on, anyone holding
the app's public key — which ships inside the app itself — can create an
account. That account gets no staff record and so has no role, but it can
still read the customer list.

Staff accounts are created by a manager, through the web app's existing
endpoint. The iOS app calls the same one.

## The request

```
POST https://<your-app-host>/api/admin/users
Authorization: Bearer <the signed-in manager's access token>
Content-Type: application/json

{
  "username": "sameer",
  "name":     "Sameer K",
  "password": "<initial password>",
  "role":     "salesman"
}
```

`role` is one of `salesman`, `warehouse`, `manager`, `admin`.

The access token is the one Supabase already gives the app at sign-in —
in the Swift SDK, `supabase.auth.session?.accessToken`. Send it as it is;
do not send the service key, and do not put any key in the app.

## What comes back

Created — HTTP 200:

```json
{ "user": { "id": "…", "username": "sameer", "full_name": "Sameer K",
            "role": "salesman", "is_active": true } }
```

Refused — HTTP 403, when the caller is not a manager or admin:

```json
{ "error": "Manager access required" }
```

Show the `error` text as it is; the messages are written to be read by people.

## Rules the server enforces

Do not re-implement these in the app — the server checks them, and the app
cannot be trusted to.

- Only a manager or admin may create a user.
- Only an admin may create another admin. A manager cannot promote anyone
  to admin, including themselves.
- Usernames are unique. A duplicate comes back as an error, not a second
  account.
- The password is the initial one; the person can change it after signing in.

## Why the app used to get "Manager access required"

The server read the session only from a browser cookie. A native app has no
cookie — it holds a token and sends it in the `Authorization` header — so
every request from iOS looked signed-out no matter who was using it.

Fixed on 29 Aug 2026: the server now accepts either. The token is verified
with Supabase rather than merely read, so an expired or forged one is
refused exactly as no token would be.

Verified with three requests: no token → refused, a salesman's token →
refused, a manager's token → user created.
