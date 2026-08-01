import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedAdmin } from "./lib/admins";

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
    session({ session }) {
      if (session.user) {
        session.user.isAdmin = isAllowedAdmin(session.user.email);
      }
      return session;
    },
  },
});
