import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/", "/_next", "/brand", "/favicon.ico"];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  // Every /api/* call the app makes internally (there are many per page —
  // preferences, expenses, products…) was paying for a real network round
  // trip to Supabase's Auth server here (getUser() re-validates against the
  // server, unlike the free local getSession() decode) on top of the same
  // check those routes already do themselves via getAppUser() server-side
  // (§Next Updates: "the sheet loading time is too much"). /login and other
  // public paths never needed the redirect gate either. Bail out before
  // touching Supabase at all for anything that doesn't need the gate.
  if (isPublic) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Deliberately NOT bouncing an authenticated session away from /login
  // here — that belongs to app/login/page.tsx, which also knows whether
  // the session has a matching `users` row. Doing it here too created a
  // redirect loop for a Supabase Auth session with no app profile: this
  // middleware would bounce /login -> /, and the page would bounce
  // straight back since it had no profile to redirect to a landing page
  // with.

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
