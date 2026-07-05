export const getInitials = (name: string, fallback: string) => {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.at(0) ?? "")
    .join("")
    .toUpperCase();

  return initials || fallback.trim().at(0)?.toUpperCase() || "?";
};
