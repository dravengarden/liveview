import { useMemo } from "react";
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
} from "@mui/material";
import type { Theme } from "@/types";

interface CsvViewerProps {
  content: string | null;
  theme: Theme;
}

function parseCsv(content: string): string[][] {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if ((char === "," || char === "\t") && !inQuotes) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

export function CsvViewer({ content }: CsvViewerProps): React.JSX.Element {
  const data = useMemo(() => {
    if (!content) return [];
    return parseCsv(content);
  }, [content]);

  const headers = data[0];
  const rows = data.slice(1);

  if (!content || data.length === 0 || !headers) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        No data
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        overflow: "auto",
        p: 2,
      }}
    >
      <TableContainer component={Paper} sx={{ maxHeight: "100%" }}>
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              {headers.map((header, index) => (
                <TableCell
                  key={index}
                  sx={{
                    fontWeight: "bold",
                    bgcolor: "background.paper",
                    whiteSpace: "nowrap",
                  }}
                >
                  {header}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow
                key={rowIndex}
                sx={{ "&:nth-of-type(odd)": { bgcolor: "action.hover" } }}
              >
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex} sx={{ whiteSpace: "nowrap" }}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
