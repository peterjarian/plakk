export const getInitials = (attrs: { firstName: string; lastName: string }) =>
  `${attrs.firstName.trim().at(0) ?? ""}${attrs.lastName.trim().at(0) ?? ""}`.toUpperCase();
