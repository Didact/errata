import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function ErratanetIntroPrompt() {
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState(false)

  const { data: enetConfig } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
  })

  const mutation = useMutation({
    mutationFn: (data: { enabled?: boolean; introSeen?: boolean }) =>
      api.erratanet.setConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['erratanet-config'] })
    },
  })

  const handleEnable = () => {
    setDismissed(true)
    mutation.mutate({ enabled: true, introSeen: true })
  }

  const handleNotNow = () => {
    setDismissed(true)
    mutation.mutate({ introSeen: true })
  }

  const open = !dismissed && enetConfig?.introSeen === false

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleNotNow()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        data-component-id="erratanet-intro-prompt"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl italic">Try ErrataNet?</DialogTitle>
          <DialogDescription className="leading-relaxed">
            ErrataNet lets you publish your stories and packs, and install community
            character cards, guidelines, and worldbuilding. It stays hidden until you
            turn it on. You can change this anytime in Settings, Remote.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={handleNotNow} disabled={mutation.isPending}>
            Not now
          </Button>
          <Button onClick={handleEnable} disabled={mutation.isPending}>
            Enable ErrataNet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
