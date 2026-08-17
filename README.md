# Auto Gemini Images

> Phiên bản hiện tại: **0.8.8** · Hoạt động trên `https://gemini.google.com/app` · Yêu cầu Chrome 116 trở lên.

Auto Gemini Images là extension Chrome Manifest V3 giúp chạy tuần tự nhiều yêu cầu tạo ảnh bằng tài khoản Gemini đang đăng nhập trên trình duyệt. Extension hỗ trợ prompt độc lập, ảnh tham chiếu, hàng chờ bền vững, tải kết quả và nhật ký chẩn đoán theo từng phiên.

## Tính năng chính

- Nhập nhiều prompt và chạy lần lượt trong Gemini.
- Gắn từ 0 đến 5 ảnh tham chiếu theo đúng thứ tự cho từng prompt.
- Tự bật chế độ **Create image**, nạp ảnh, nhập prompt và xác nhận Gemini đã nhận đủ nội dung trước khi theo dõi kết quả.
- Tạm dừng, tiếp tục, dừng, thử lại hoặc xóa từng tác vụ trong hàng chờ.
- Giữ hàng chờ, ảnh tham chiếu, kết quả và nhật ký khi đóng rồi mở lại side panel.
- Tự phục hồi việc theo dõi nếu side panel bị reload sau khi prompt đã được gửi, không gửi lại prompt lần hai.
- Tải ảnh thủ công hoặc tự động vào thư mục con trong Downloads.
- Tích hợp tùy chọn với ứng dụng storyboard chạy tại `localhost` hoặc `127.0.0.1`.

## Yêu cầu trước khi cài

- Google Chrome phiên bản 116 trở lên.
- Đã đăng nhập tài khoản tại [Gemini](https://gemini.google.com/app).
- Thư mục mã nguồn đã được giải nén đầy đủ. Không chọn trực tiếp file ZIP khi dùng **Load unpacked**.

## Cài đặt bằng Chrome Developer Mode

1. Tải hoặc clone repository này về máy.
2. Mở Chrome và truy cập `chrome://extensions`.
3. Bật công tắc **Developer mode / Chế độ dành cho nhà phát triển** ở góc trên bên phải.
4. Bấm **Load unpacked / Tải tiện ích đã giải nén**.
5. Chọn đúng thư mục gốc `auto-gemini-images` — thư mục này phải chứa file `manifest.json`.
6. Kiểm tra thẻ extension hiển thị tên **Auto Gemini Images** và phiên bản **0.8.8**.
7. Mở `https://gemini.google.com/app`, đăng nhập nếu cần.
8. Bấm biểu tượng extension trên thanh công cụ Chrome để mở side panel. Nếu chưa thấy biểu tượng, mở menu Extensions hình mảnh ghép và ghim **Auto Gemini Images**.

### Cập nhật bản mã nguồn mới

1. Thay thế hoặc pull mã nguồn mới nhất.
2. Mở `chrome://extensions`.
3. Bấm **Reload / Tải lại** trên thẻ **Auto Gemini Images**.
4. Reload riêng tab Gemini và trang storyboard đang mở.
5. Đóng rồi mở lại side panel.
6. Chạy một tác vụ mới và kiểm tra dòng đầu nhật ký có dạng `Extension 0.8.8`.

Nếu nhật ký vẫn hiển thị phiên bản cũ, Chrome vẫn đang chạy một bản extension khác. Hãy tắt hoặc xóa bản cũ, sau đó load lại đúng thư mục mã nguồn.

## Tạo ảnh trực tiếp bằng extension

1. Mở Gemini và side panel **Auto Gemini Images**.
2. Tại tab **Tạo ảnh hàng loạt**, nhập một hoặc nhiều prompt.
   - Nếu có dòng trống giữa các đoạn, mỗi đoạn là một prompt.
   - Nếu không có dòng trống, mỗi dòng không rỗng là một prompt.
3. Chọn tỉ lệ ảnh cho từng dòng prompt.
4. Thêm tối đa 5 ảnh tham chiếu bằng nút **+ Ref**. Có thể đổi thứ tự hoặc xóa ảnh trước khi chạy.
5. Bấm **Thêm vào hàng chờ** để chuẩn bị, hoặc **Thêm và chạy** để bắt đầu ngay.
6. Theo dõi trạng thái tại tab **Hàng chờ**.
7. Mở tab **Nhật ký** nếu cần xem hoặc sao chép chẩn đoán của từng phiên.

Extension xử lý từng tác vụ tuần tự. Chỉ khi ảnh của tác vụ hiện tại được thu thập và lưu thành công, tác vụ kế tiếp mới bắt đầu.

## Sử dụng ảnh tham chiếu

Ảnh được nạp qua vùng soạn thảo thật của Gemini và phải xuất hiện ở trạng thái sẵn sàng trước khi extension nhập và gửi prompt. Sau khi bấm gửi, extension tiếp tục xác nhận lượt chat mới chứa cả prompt và ảnh tham chiếu.

Nếu lần bấm **Send** đầu tiên không tạo lượt chat mới nhưng prompt và ảnh vẫn còn nguyên trong ô soạn, extension 0.8.8 sẽ thử lại nút gửi đúng một lần. Cơ chế này giúp hàng chờ tiếp tục mà không gửi trùng một prompt đã được Gemini tiếp nhận.

## Quản lý hàng chờ

- **Bắt đầu hàng chờ:** chạy các tác vụ đang chờ theo thứ tự.
- **Tạm dừng:** dừng tại ranh giới an toàn, không cắt ngang thao tác đang ghi dữ liệu.
- **Tiếp tục:** tiếp tục từ tác vụ chưa hoàn tất.
- **Dừng:** ngừng runner hiện tại.
- **Thử lại:** chạy lại tác vụ lỗi trong một New Chat mới để không tái sử dụng draft Gemini bị kẹt.
- **Xóa:** xóa tác vụ khỏi hàng chờ cục bộ.

## Tải và lưu ảnh

Trong tab **Cài đặt**, có thể cấu hình:

- Thời gian chờ Gemini tạo ảnh.
- Khoảng nghỉ giữa các tác vụ.
- Tự động tải kết quả.
- Thư mục con bên trong Downloads.

Chế độ tự động lưu là cách ổn định nhất để giữ đúng thư mục đích. Nếu Chrome bật hộp thoại **Save As**, người dùng vẫn có thể thay đổi đường dẫn thủ công.

## Tích hợp storyboard cục bộ

Extension có bridge riêng theo giao thức `vox-gemini/2`, vì vậy có thể cài đồng thời với Auto ChatGPT Images. Dữ liệu batch bền vững vẫn dùng hợp đồng `vox-chatgpt/1` để tương thích với ứng dụng hiện tại.

Quy trình sử dụng:

1. Chạy ứng dụng storyboard tại `localhost` hoặc `127.0.0.1`.
2. Reload extension, trang storyboard và tab Gemini sau mỗi lần cập nhật mã nguồn.
3. Tại storyboard, bấm **Generate with Gemini**.
4. Extension nhận prompt, tỉ lệ, ảnh tham chiếu và thứ tự tác vụ vào cùng hàng chờ tuần tự.
5. Khi lấy được bytes ảnh, extension chỉ đánh dấu hoàn tất sau khi storyboard xác nhận đã lưu kết quả.

Môi trường phát triển cục bộ mặc định sử dụng `http://127.0.0.1:4174` và không yêu cầu API token. URL, token và batch ID thủ công trong phần cài đặt chỉ dành cho phục hồi hoặc môi trường kết nối khác.

## Xử lý lỗi thường gặp

### Extension không được phát hiện trên trang storyboard

- Kiểm tra extension đang bật trong `chrome://extensions`.
- Bấm **Reload** trên thẻ extension.
- Reload riêng trang storyboard để bridge mới được nạp.
- Đóng rồi mở lại side panel.

### Chỉ nhập prompt nhưng không gửi ảnh

- Xác nhận đang dùng phiên bản 0.8.8 trong dòng `session_start`.
- Xóa hoặc thử lại tác vụ lỗi để extension mở New Chat sạch.
- Không thao tác thủ công vào ô soạn trong lúc tác vụ đang ở giai đoạn nạp ảnh hoặc gửi prompt.

### `SUBMISSION_AMBIGUOUS`

Extension không chứng minh được Gemini đã nhận đầy đủ prompt và ảnh. Từ bản 0.8.8, extension nhận diện nội dung thật của lượt người dùng, bỏ qua nhãn hỗ trợ truy cập như “You said”, đồng thời thử lại Send một lần nếu lần đầu chắc chắn chưa gửi.

### `UPLOAD_VERIFICATION_FAILED`

Gemini không hiển thị ảnh tham chiếu ở trạng thái sẵn sàng trong thời gian cho phép. Kiểm tra định dạng và kích thước ảnh, kết nối mạng, sau đó thử lại trong New Chat.

### `RESULT_FETCH_FAILED`

Gemini đã tạo ảnh nhưng trình duyệt không cung cấp bytes đọc được. Extension lần lượt thử canvas, fetch blob và luồng tải ảnh kích thước đầy đủ. Hãy sao chép toàn bộ nhật ký phiên nếu lỗi vẫn lặp lại.

## Phát triển và kiểm tra

Cài dependencies rồi chạy:

```bash
npm install
npm run check
npm test
```

Đóng gói bản phát hành Chrome Web Store:

```bash
npm run package
```

File ZIP được tạo trong thư mục `dist/` theo phiên bản trong `manifest.json`, ví dụ:

```text
dist/auto-gemini-images-0.8.8.zip
```

Các selector và nhãn giao diện Gemini nằm tại `config/gemini-selectors.json`. Mã điều phối nên sử dụng các selector này thay vì chèn selector rời rạc vào nhiều nơi.

## Quyền riêng tư và an toàn

- Extension chỉ thao tác trên tab Gemini đang đăng nhập và các trang phát triển cục bộ được khai báo trong manifest.
- Prompt, ảnh tham chiếu, hàng chờ và kết quả được lưu cục bộ để phục hồi công việc.
- Extension không vượt qua đăng nhập, xác minh tài khoản, CAPTCHA, giới hạn sử dụng hoặc chính sách an toàn của Gemini.
- Các trạng thái cần người dùng xử lý sẽ được ghi thành lỗi rõ ràng trong nhật ký.

Xem thêm [Chính sách quyền riêng tư](docs/privacy-policy.md) và [Tài liệu sản phẩm](docs/product-brief.md).
