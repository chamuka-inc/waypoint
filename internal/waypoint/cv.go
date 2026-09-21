package waypoint

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/ledongthuc/pdf"
)

func ImportCV(name, encoded string) (string, error) {
	if name == "" || len(encoded) > 11_200_000 {
		return "", errors.New("choose a CV smaller than 8 MB")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > 8*1024*1024 {
		return "", errors.New("choose a CV smaller than 8 MB")
	}
	var text string
	switch strings.ToLower(filepath.Ext(name)) {
	case ".txt", ".md":
		text = string(data)
	case ".docx":
		text, err = extractDOCX(data)
	case ".pdf":
		text, err = extractPDF(data)
	default:
		return "", errors.New("use PDF, DOCX, TXT, or Markdown")
	}
	if err != nil {
		return "", errors.New("no usable text was found. For a scanned PDF, paste an OCR text version of your CV")
	}
	text = strings.TrimSpace(text)
	if len(text) < 30 {
		return "", errors.New("no usable text was found. For a scanned PDF, paste an OCR text version of your CV")
	}
	if len(text) > 60000 {
		return "", errors.New("the extracted CV is too long. Use a shorter document")
	}
	return text, nil
}

func extractDOCX(data []byte) (string, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	for _, file := range reader.File {
		if file.Name != "word/document.xml" {
			continue
		}
		stream, err := file.Open()
		if err != nil {
			return "", err
		}
		defer stream.Close()
		decoder := xml.NewDecoder(io.LimitReader(stream, 16*1024*1024))
		var output strings.Builder
		for {
			token, err := decoder.Token()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return "", err
			}
			switch value := token.(type) {
			case xml.CharData:
				output.Write(value)
			case xml.EndElement:
				if value.Name.Local == "p" || value.Name.Local == "tr" {
					output.WriteByte('\n')
				} else if value.Name.Local == "t" {
					output.WriteByte(' ')
				}
			}
		}
		return output.String(), nil
	}
	return "", errors.New("document body missing")
}

func extractPDF(data []byte) (string, error) {
	file, err := os.CreateTemp("", "waypoint-cv-*.pdf")
	if err != nil {
		return "", err
	}
	path := file.Name()
	defer os.Remove(path)
	if _, err := file.Write(data); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	opened, reader, err := pdf.Open(path)
	if err != nil {
		return "", err
	}
	defer opened.Close()
	if reader.NumPage() > 40 {
		return "", errors.New("CVs are limited to 40 pages")
	}
	plain, err := reader.GetPlainText()
	if err != nil {
		return "", err
	}
	text, err := io.ReadAll(io.LimitReader(plain, 60001))
	return string(text), err
}
