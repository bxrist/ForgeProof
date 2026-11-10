import { useEffect, useRef, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Redirect, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import forgeProofLogo from "@assets/ForgeProof_1793921023505.png";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");

const clerkAppearance = {
  theme: shadcn,
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: new URL(forgeProofLogo, window.location.origin).href,
  },
  variables: {
    colorPrimary: "#2563eb",
    colorForeground: "#f8fafc",
    colorMutedForeground: "#cbd5e1",
    colorDanger: "#fca5a5",
    colorBackground: "#0f172a",
    colorInput: "#1e293b",
    colorInputForeground: "#f8fafc",
    colorNeutral: "#f8fafc",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: { width: "100%", display: "flex", justifyContent: "center" },
    cardBox: { backgroundColor: "#0f172a", width: "440px", maxWidth: "100%", borderRadius: "1rem", overflow: "hidden" },
    card: { background: "transparent", boxShadow: "none", border: 0 },
    footer: { background: "transparent", boxShadow: "none", border: 0 },
    headerTitle: { color: "#f8fafc" },
    headerSubtitle: { color: "#cbd5e1" },
    socialButtonsBlockButtonText: { color: "#f8fafc" },
    formFieldLabel: { color: "#f8fafc" },
    footerActionLink: { color: "#93c5fd" },
    footerActionText: { color: "#cbd5e1" },
    dividerText: { color: "#cbd5e1" },
    identityPreviewEditButton: { color: "#93c5fd" },
    formFieldSuccessText: { color: "#86efac" },
    alertText: { color: "#f8fafc" },
    logoBox: { height: "144px" },
    logoImage: { height: "136px", width: "204px", objectFit: "contain" },
    socialButtonsBlockButton: { background: "#1e293b", borderColor: "#64748b" },
    formButtonPrimary: { background: "#2563eb", color: "#ffffff" },
    formFieldInput: { background: "#1e293b", color: "#f8fafc" },
    footerAction: { background: "transparent" },
    dividerLine: { background: "#64748b" },
    alert: { background: "#334155" },
    otpCodeFieldInput: { background: "#1e293b", color: "#f8fafc" },
    formFieldRow: { marginBottom: "1rem" },
    main: { gap: "1.25rem" },
  },
};

export function ForgeProofClerkProvider({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      signInFallbackRedirectUrl={`${basePath}/dashboard`}
      signUpFallbackRedirectUrl={`${basePath}/dashboard`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to your ForgeProof account" } },
        signUp: { start: { title: "Create your account", subtitle: "Get started with ForgeProof" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      {children}
    </ClerkProvider>
  );
}

export function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) queryClient.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);
  return null;
}

export function SignInPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
  </div>;
}

export function SignUpPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
  </div>;
}

export function ProtectedPage({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const account = useQuery<{ id: string }>({
    queryKey: ["/api/me"], enabled: isLoaded && !!isSignedIn,
  });
  if (!isLoaded) return <p className="p-8">Loading account…</p>;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  if (account.isError) return <div className="p-8" role="alert">
    <h1>Account access unavailable</h1>
    <p>We couldn’t load your ForgeProof account. Please retry or contact your administrator.</p>
    <button onClick={() => account.refetch()}>Retry</button>
  </div>;
  if (!account.data) return <p className="p-8">Loading account…</p>;
  return <>{children}</>;
}
