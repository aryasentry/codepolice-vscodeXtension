import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
    throw new Error('[CodePolice Server] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.');
}

export const supabase = createClient(url, key, {
    auth: { persistSession: false },
});
