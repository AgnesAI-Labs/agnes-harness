#pragma once
// Platform-neutral decision for Windows private file and directory security descriptors.
// The Windows caller classifies each SID; this header only decides, so the rule can be
// compiled and tested on any platform with synthetic descriptors.

enum class PrivatePrincipal { CurrentUser, LocalSystem, Administrators, Other };
enum class PrivateAceKind { Allowed, Denied, Unsupported };

struct PrivateAce {
  PrivateAceKind kind;
  unsigned long mask;
  PrivatePrincipal principal;
};

// An owner can always rewrite the DACL, so only principals the DACL rule below already trusts
// with full access may own a private object. The current user is the normal owner. An elevated
// administrator token names BUILTIN\Administrators as the default owner of every object it
// creates, so that owner must be accepted too; it confers nothing the Administrators access entry
// does not already allow. SYSTEM is not needed as an owner and stays refused.
inline bool privateOwnerTrusted(PrivatePrincipal owner) {
  return owner == PrivatePrincipal::CurrentUser || owner == PrivatePrincipal::Administrators;
}

// Deny entries only narrow access. Any other entry type is refused outright, and an allow entry
// with a nonempty mask must name the current user, SYSTEM or Administrators.
inline bool privateAceTrusted(const PrivateAce& ace) {
  if (ace.kind == PrivateAceKind::Denied) return true;
  if (ace.kind != PrivateAceKind::Allowed) return false;
  return ace.mask == 0 || ace.principal != PrivatePrincipal::Other;
}
