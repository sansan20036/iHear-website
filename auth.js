import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { resolveAdminPrincipal } from "./lib/admins";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  trustHost: true,
  pages: {
    error: "/auth-error",
  },
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  jwt: {
    maxAge: 30 * 24 * 60 * 60,
  },
  callbacks: {
    async session({ session }) {
      if (session.user) {
        const principal = await resolveAdminPrincipal(session.user.email);
        session.user.isAdmin = Boolean(principal);
        session.user.adminRole = principal?.role || null;
      }
      return session;
    },
  },
});
