const booleanPref = (key: string, fallback: boolean) => {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === 'true';
  } catch {
    return fallback;
  }
};

const setBooleanPref = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // ignore storage issues
  }
};

export { booleanPref as getBooleanPref, setBooleanPref };

