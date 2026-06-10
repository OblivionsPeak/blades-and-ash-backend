export function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.profile?.role;
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
