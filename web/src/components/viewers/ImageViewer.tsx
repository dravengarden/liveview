import { Box } from "@mui/material";
import { remoteUrl } from "@/apiBase";

interface ImageViewerProps {
  path: string;
}

export function ImageViewer({ path }: ImageViewerProps): React.JSX.Element {
  // Absolute in the bundled native shell: a relative URL would resolve against
  // the lvsync:// document origin, which does not serve /api/raw.
  const imageUrl = remoteUrl(`/api/raw?path=${encodeURIComponent(path)}`);

  return (
    <Box
      sx={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "auto",
        p: 2,
        bgcolor: "background.default",
      }}
    >
      <Box
        component="img"
        src={imageUrl}
        alt={path}
        sx={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: 1,
          boxShadow: 1,
        }}
      />
    </Box>
  );
}
