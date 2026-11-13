export const ponytailModes = ["off", "lite", "full"] as const;
export type PonytailMode = (typeof ponytailModes)[number];
export const defaultPonytailMode: PonytailMode = "full";
export const ponytailVersion = "4.10.2";
export const ponytailRevision = "a17afe0712fc43b08f812d54391a0e5c35353b61";
export const ponytailPolicyVersion = "bell-ponytail-v1";
export const ponytailSource = "https://github.com/DietrichGebert/ponytail";
