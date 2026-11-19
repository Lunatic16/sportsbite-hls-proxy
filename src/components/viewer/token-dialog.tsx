'use client';

/**
 * Auth token entry dialog. Shown automatically when the API answers 401/403
 * — no more "add ?token= to the URL by hand" dead end.
 */
import { useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useViewer } from '@/lib/store';
import { toast } from 'sonner';

export function TokenDialog({ onSaved }: { onSaved: () => void }) {
  const open = useViewer((s) => s.tokenDialogOpen);
  const setOpen = useViewer((s) => s.setTokenDialogOpen);
  const setToken = useViewer((s) => s.setToken);
  const [value, setValue] = useState('');

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error('Enter the AUTH_TOKEN configured on the server');
      return;
    }
    setToken(trimmed);
    setOpen(false);
    setValue('');
    toast.success('Token saved — retrying');
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Authentication required</DialogTitle>
          <DialogDescription>
            This server is protected with an <code className="rounded bg-muted px-1 py-0.5 text-xs">AUTH_TOKEN</code>.
            Paste it here once — it is stored in this browser and attached to every request automatically.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="password"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="AUTH_TOKEN"
          aria-label="Auth token"
        />
        <DialogFooter>
          <Button onClick={save}>Save &amp; retry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
